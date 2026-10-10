import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checksumOf,
  defaultMigrationsDir,
  discoverMigrations,
  MigrationError,
  migrationStatus,
  runMigrations,
} from './migrations.js';
import { checkDatabase, createPool, type Pool } from './pool.js';

async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ernie-mig-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql, 'utf8');
  }
  return dir;
}

describe('discoverMigrations', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('ordina per versione e calcola il checksum', async () => {
    dir = await tempDir({
      '0002_second.sql': 'SELECT 2;',
      '0001_first.sql': 'SELECT 1;',
      'README.md': 'ignorato',
    });
    const files = await discoverMigrations(dir);
    expect(files.map((f) => f.file)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(files[0]?.version).toBe(1);
    expect(files[0]?.name).toBe('first');
    expect(files[0]?.checksum).toBe(checksumOf('SELECT 1;'));
  });

  it('rifiuta nomi non conformi', async () => {
    dir = await tempDir({ 'init.sql': 'SELECT 1;' });
    await expect(discoverMigrations(dir)).rejects.toThrowError(MigrationError);
  });

  it('rifiuta versioni duplicate', async () => {
    dir = await tempDir({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' });
    await expect(discoverMigrations(dir)).rejects.toThrowError(/duplicata/);
  });

  it('le migrazioni reali del repository sono valide', async () => {
    const files = await discoverMigrations(defaultMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.version).toBe(1);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('runMigrations (integrazione, richiede DATABASE_URL)', () => {
  let pool: Pool;
  let dir: string;
  const table = `test_migrations_${Date.now().toString(36)}`;
  const probeTable = `probe_${Date.now().toString(36)}`;

  beforeAll(() => {
    pool = createPool({ connectionString: DATABASE_URL as string, max: 2 });
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.query(`DROP TABLE IF EXISTS "${probeTable}"`);
    await pool.end();
  });

  beforeEach(async () => {
    dir = await tempDir({
      '0001_create_probe.sql': `CREATE TABLE "${probeTable}" (id serial PRIMARY KEY, note text);`,
      '0002_seed_probe.sql': `INSERT INTO "${probeTable}" (note) VALUES ('seed');`,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('raggiunge il database', async () => {
    const info = await checkDatabase(pool);
    expect(info.serverVersion).toMatch(/PostgreSQL/);
  });

  it('applica le migrazioni una sola volta ed è idempotente', async () => {
    const first = await runMigrations(pool, { dir, table });
    expect(first.applied.map((m) => m.file)).toEqual([
      '0001_create_probe.sql',
      '0002_seed_probe.sql',
    ]);
    expect(first.alreadyApplied).toBe(0);

    const second = await runMigrations(pool, { dir, table });
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toBe(2);

    const rows = await pool.query(`SELECT count(*)::int AS n FROM "${probeTable}"`);
    expect(rows.rows[0]?.n).toBe(1);

    const status = await migrationStatus(pool, { dir, table });
    expect(status.pending).toHaveLength(0);
    expect(status.applied).toHaveLength(2);
  });

  it('rileva la modifica di una migrazione già applicata', async () => {
    await runMigrations(pool, { dir, table });
    await writeFile(
      join(dir, '0002_seed_probe.sql'),
      `INSERT INTO "${probeTable}" (note) VALUES ('changed');`,
      'utf8',
    );
    await expect(runMigrations(pool, { dir, table })).rejects.toThrowError(/checksum/);
  });

  it('esegue il rollback di una migrazione fallita', async () => {
    await runMigrations(pool, { dir, table });
    await writeFile(
      join(dir, '0003_broken.sql'),
      `INSERT INTO "${probeTable}" (note) VALUES ('x'); SELECT * FROM tabella_inesistente;`,
      'utf8',
    );
    await expect(runMigrations(pool, { dir, table })).rejects.toThrowError(/0003_broken/);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM "${probeTable}"`);
    expect(rows.rows[0]?.n).toBe(1);
  });
});
