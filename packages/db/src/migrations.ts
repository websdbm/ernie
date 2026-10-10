import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

/**
 * Runner minimale e deterministico di migrazioni SQL.
 *
 * - File `NNNN_nome.sql` in ordine numerico, applicati una sola volta.
 * - Ogni migrazione gira in una transazione; il checksum viene registrato e
 *   verificato alle esecuzioni successive (una migrazione già applicata non può cambiare).
 * - Advisory lock per impedire esecuzioni concorrenti (es. più repliche all'avvio).
 */

export const DEFAULT_MIGRATIONS_TABLE = 'schema_migrations';
const LOCK_KEY = 727_001;
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly file: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface MigrateOptions {
  readonly dir?: string;
  readonly table?: string;
  readonly logger?: MigrationLogger;
}

export interface MigrateResult {
  readonly applied: readonly MigrationFile[];
  readonly alreadyApplied: number;
  readonly total: number;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

const silentLogger: MigrationLogger = { info() {}, warn() {} };

/** Cartella `infrastructure/migrations` del repository (valida sia da src/ che da dist/). */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../../infrastructure/migrations/', import.meta.url));
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function discoverMigrations(dir = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;
    const match = FILE_RE.exec(entry.name);
    if (!match) {
      throw new MigrationError(
        `Nome di migrazione non valido: "${entry.name}" (atteso NNNN_nome_snake_case.sql)`,
      );
    }
    const version = Number(match[1]);
    const name = match[2] ?? '';
    const dup = seen.get(version);
    if (dup) {
      throw new MigrationError(`Versione duplicata ${version}: "${dup}" e "${entry.name}"`);
    }
    seen.set(version, entry.name);
    const path = join(dir, entry.name);
    const sql = await readFile(path, 'utf8');
    files.push({ version, name, file: entry.name, path, sql, checksum: checksumOf(sql) });
  }

  return files.sort((a, b) => a.version - b.version);
}

function quoteIdent(table: string): string {
  if (!IDENT_RE.test(table)) {
    throw new MigrationError(`Nome tabella migrazioni non valido: "${table}"`);
  }
  return `"${table}"`;
}

async function ensureTable(pool: Pool, table: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(pool: Pool, table: string): Promise<AppliedMigration[]> {
  const res = await pool.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`SELECT version, name, checksum, applied_at FROM ${quoteIdent(table)} ORDER BY version`);
  return res.rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

function verifyChecksums(files: readonly MigrationFile[], applied: readonly AppliedMigration[]) {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const a of applied) {
    const f = byVersion.get(a.version);
    if (!f) {
      throw new MigrationError(
        `La migrazione ${a.version} (${a.name}) è registrata nel database ma il file manca`,
      );
    }
    if (f.checksum !== a.checksum) {
      throw new MigrationError(
        `La migrazione ${a.version} (${f.file}) è stata modificata dopo l'applicazione (checksum diverso)`,
      );
    }
  }
}

export async function migrationStatus(
  pool: Pool,
  opts: MigrateOptions = {},
): Promise<{ applied: AppliedMigration[]; pending: MigrationFile[] }> {
  const table = opts.table ?? DEFAULT_MIGRATIONS_TABLE;
  const files = await discoverMigrations(opts.dir);
  await ensureTable(pool, table);
  const applied = await readApplied(pool, table);
  verifyChecksums(files, applied);
  const appliedVersions = new Set(applied.map((a) => a.version));
  return { applied, pending: files.filter((f) => !appliedVersions.has(f.version)) };
}

export async function runMigrations(pool: Pool, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const table = opts.table ?? DEFAULT_MIGRATIONS_TABLE;
  const log = opts.logger ?? silentLogger;
  const client = await pool.connect();
  const appliedNow: MigrationFile[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(pool, table);
    const files = await discoverMigrations(opts.dir);
    const applied = await readApplied(pool, table);
    verifyChecksums(files, applied);
    const appliedVersions = new Set(applied.map((a) => a.version));
    const pending = files.filter((f) => !appliedVersions.has(f.version));

    log.info('migrazioni: stato', {
      total: files.length,
      applied: applied.length,
      pending: pending.length,
    });

    for (const m of pending) {
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO ${quoteIdent(table)} (version, name, checksum) VALUES ($1, $2, $3)`,
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        const reason = err instanceof Error ? err.message : String(err);
        throw new MigrationError(`Migrazione ${m.file} fallita: ${reason}`);
      }
      appliedNow.push(m);
      log.info('migrazione applicata', { file: m.file, durationMs: Date.now() - started });
    }

    return { applied: appliedNow, alreadyApplied: applied.length, total: files.length };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
