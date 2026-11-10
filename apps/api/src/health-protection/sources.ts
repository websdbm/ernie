import { createHash } from 'node:crypto';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import { z } from 'zod';
import { type HealthCipher, HealthProtectionError } from './crypto.js';

const ID = z.uuid().transform((s) => s.toLowerCase());
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_PAGES_CHARS = 400_000;
export const HEALTH_SOURCE_LIST_LIMIT = 2_000;
const MAX_SOURCE_LIST = HEALTH_SOURCE_LIST_LIMIT;
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const AttachmentMeta = z
  .object({
    id: ID,
    name: z.string().min(1).max(255),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
  })
  .strict();
const AttachmentInput = AttachmentMeta.omit({ bytes: true })
  .extend({
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil((8 * 1024 * 1024) / 3) * 4),
  })
  .strict();
const Pages = z
  .array(z.string().max(MAX_PAGES_CHARS))
  .min(1)
  .max(500)
  .refine((pages) => pages.reduce((n, page) => n + page.length, 0) <= MAX_PAGES_CHARS);
export const HealthSourceInput = z
  .object({
    id: ID,
    title: z.string().min(1).max(160),
    source: z.enum(['scan', 'photo', 'pdf', 'text']),
    pages: Pages,
    attachments: z.array(AttachmentInput).max(10).default([]),
  })
  .strict();
export type HealthSourceInput = z.input<typeof HealthSourceInput>;
const SourcePayload = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(160),
    source: z.enum(['scan', 'photo', 'pdf', 'text']),
    pages: Pages,
    attachments: z.array(AttachmentMeta.extend({ sha256: HASH })).max(10),
    inputHash: HASH,
  })
  .strict();
const AssetPayload = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: ID,
    attachment: AttachmentInput,
  })
  .strict();
const LegacyPayload = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: ID.nullable(),
    kind: z.enum(['document', 'note', 'media', 'report', 'notice', 'migration']),
    originalId: z.string().min(1).max(2048),
    contents: z.unknown(),
  })
  .strict();
export type HealthSourceAttachment = z.infer<typeof AttachmentMeta>;
export interface HealthSourceSummary {
  id: string;
  title: string;
  source: z.infer<typeof SourcePayload>['source'];
  pages: number;
  createdAt: string;
  status: 'pending' | 'analyzed';
  reportId: string | null;
}
export interface HealthSourceRecord extends Omit<HealthSourceSummary, 'pages'> {
  pages: string[];
  attachments: HealthSourceAttachment[];
}
export interface HealthLegacyResourceInput {
  id: string;
  sourceId: string | null;
  kind: 'document' | 'note' | 'media' | 'report' | 'notice' | 'migration';
  originalId: string;
  contents: unknown;
}
interface SourceRow {
  id: string;
  revision: number;
  envelope: unknown;
  created_at: Date;
  report_id?: string | null;
}
interface AssetRow {
  id: string;
  source_id: string;
  revision: number;
  envelope: unknown;
}

/** Deterministic digest for explicit comparisons only. Never logged or written in plaintext SQL. */
export function healthContentHash(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (entry instanceof Date) return entry.toISOString();
    if (entry instanceof Uint8Array) return { binary: Buffer.from(entry).toString('base64') };
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return entry;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function encryptHealthJson(
  cipher: HealthCipher,
  userId: string,
  kind: string,
  id: string,
  payload: unknown,
) {
  const bytes = Buffer.from(JSON.stringify(payload));
  try {
    return cipher.encrypt(
      { userId, resourceKind: kind, resourceId: id, resourceVersion: 1 },
      bytes,
    );
  } finally {
    bytes.fill(0);
  }
}
export function decryptHealthJson<T>(
  cipher: HealthCipher,
  userId: string,
  kind: string,
  row: { id: string; revision: number; envelope: unknown },
  schema: z.ZodType<T>,
): T {
  const bytes = cipher.decrypt(
    { userId, resourceKind: kind, resourceId: row.id, resourceVersion: row.revision },
    row.envelope,
  );
  try {
    return schema.parse(JSON.parse(UTF8.decode(bytes)));
  } finally {
    bytes.fill(0);
  }
}
const safe = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch {
    throw new HealthProtectionError();
  }
};
function attachmentMeta(input: z.infer<typeof AttachmentInput>) {
  const bytes = Buffer.from(input.dataBase64, 'base64');
  try {
    const max = input.mimeType === 'application/pdf' ? 8 * 1024 * 1024 : 3 * 1024 * 1024;
    if (!bytes.length || bytes.length > max || bytes.toString('base64') !== input.dataBase64)
      throw new HealthProtectionError();
    const { dataBase64: _, ...metadata } = input;
    return {
      ...metadata,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    bytes.fill(0);
  }
}
function prepare(raw: HealthSourceInput) {
  const input = HealthSourceInput.parse(raw);
  if (
    Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES ||
    new Set(input.attachments.map((a) => a.id)).size !== input.attachments.length
  )
    throw new HealthProtectionError();
  const payload = SourcePayload.parse({
    schemaVersion: 1,
    title: input.title,
    source: input.source,
    pages: input.pages,
    attachments: input.attachments.map(attachmentMeta),
    inputHash: healthContentHash(input),
  });
  return { input, payload };
}
const sourcePayload = (cipher: HealthCipher, owner: string, row: SourceRow) =>
  decryptHealthJson(cipher, owner, 'source', row, SourcePayload);
const summary = (row: SourceRow, payload: z.infer<typeof SourcePayload>): HealthSourceSummary => ({
  id: row.id,
  title: payload.title,
  source: payload.source,
  pages: payload.pages.length,
  createdAt: row.created_at.toISOString(),
  status: row.report_id ? 'analyzed' : 'pending',
  reportId: row.report_id ?? null,
});

/** Use from an AI write guard in its existing transaction. Deletion waits for authorized writes. */
export async function lockHealthSource(
  client: PoolClient,
  userId: string,
  sourceId: string,
): Promise<void> {
  const result = await client.query(
    'SELECT id FROM health_secure_sources WHERE user_id=$1 AND id=$2 FOR SHARE',
    [ID.parse(userId), ID.parse(sourceId)],
  );
  if (!result.rowCount) throw new HealthProtectionError();
}

/** Shared with the migration, never acquires a second pool slot and never commits independently. */
export async function saveHealthSourceInTransaction(
  client: PoolClient,
  cipher: HealthCipher,
  userId: string,
  raw: HealthSourceInput,
  createdAt?: Date,
): Promise<void> {
  const owner = ID.parse(userId);
  const { input, payload } = prepare(raw);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${owner}:health-source:${input.id}`,
  ]);
  const known = await client.query<SourceRow>(
    'SELECT id,revision,envelope,created_at FROM health_secure_sources WHERE user_id=$1 AND id=$2 FOR UPDATE',
    [owner, input.id],
  );
  if (known.rows[0]) {
    if (sourcePayload(cipher, owner, known.rows[0]).inputHash !== payload.inputHash)
      throw new HealthProtectionError();
    // A repeated save also verifies every attachment, not just the source digest.
    for (const attachment of input.attachments) {
      const found = await client.query<AssetRow>(
        'SELECT id,source_id,revision,envelope FROM health_secure_assets WHERE user_id=$1 AND id=$2',
        [owner, attachment.id],
      );
      const row = found.rows[0];
      if (!row || row.source_id !== input.id) throw new HealthProtectionError();
      const actual = decryptHealthJson(cipher, owner, 'asset', row, AssetPayload);
      if (
        actual.sourceId !== input.id ||
        healthContentHash(actual.attachment) !== healthContentHash(attachment)
      )
        throw new HealthProtectionError();
    }
    return;
  }
  await client.query(
    `INSERT INTO health_secure_sources(user_id,id,envelope,created_at) VALUES ($1,$2,$3::jsonb,COALESCE($4,now()))`,
    [
      owner,
      input.id,
      JSON.stringify(encryptHealthJson(cipher, owner, 'source', input.id, payload)),
      createdAt ?? null,
    ],
  );
  for (const attachment of input.attachments) {
    const encrypted = encryptHealthJson(
      cipher,
      owner,
      'asset',
      attachment.id,
      AssetPayload.parse({ schemaVersion: 1, sourceId: input.id, attachment }),
    );
    await client.query(
      'INSERT INTO health_secure_assets(user_id,id,source_id,envelope) VALUES ($1,$2,$3,$4::jsonb)',
      [owner, attachment.id, input.id, JSON.stringify(encrypted)],
    );
  }
}

/** Archive an exact known resource. The caller verifies migration eligibility; no generic data is deleted here. */
export async function archiveHealthLegacyInTransaction(
  client: PoolClient,
  cipher: HealthCipher,
  userId: string,
  input: HealthLegacyResourceInput,
): Promise<void> {
  const owner = ID.parse(userId);
  const id = ID.parse(input.id);
  const payload = LegacyPayload.parse({
    schemaVersion: 1,
    sourceId: input.sourceId,
    kind: input.kind,
    originalId: input.originalId,
    contents: input.contents,
  });
  await client.query(
    `INSERT INTO health_secure_legacy_resources(user_id,id,source_id,envelope) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(user_id,id) DO NOTHING`,
    [
      owner,
      id,
      payload.sourceId,
      JSON.stringify(encryptHealthJson(cipher, owner, 'legacy-resource', id, payload)),
    ],
  );
  const result = await client.query<AssetRow>(
    'SELECT id,source_id,revision,envelope FROM health_secure_legacy_resources WHERE user_id=$1 AND id=$2',
    [owner, id],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.source_id !== payload.sourceId ||
    healthContentHash(decryptHealthJson(cipher, owner, 'legacy-resource', row, LegacyPayload)) !==
      healthContentHash(payload)
  )
    throw new HealthProtectionError();
}

export function createEncryptedHealthSourceStore(pool: Pool, cipher: HealthCipher) {
  const tx = <T>(userId: string, work: (client: PoolClient, owner: string) => Promise<T>) =>
    safe(() => {
      const owner = ID.parse(userId);
      return withUser(pool, owner, (client) => work(client, owner));
    });
  const read = async (client: PoolClient, owner: string, id: string) => {
    const rows = await client.query<SourceRow>(
      `SELECT s.id,s.revision,s.envelope,s.created_at,r.id AS report_id FROM health_secure_sources s
      LEFT JOIN health_secure_reports r ON r.user_id=s.user_id AND r.source_document_id=s.id WHERE s.user_id=$1 AND s.id=$2`,
      [owner, ID.parse(id)],
    );
    return rows.rows[0];
  };
  return {
    save(userId: string, input: HealthSourceInput): Promise<HealthSourceSummary> {
      return tx(userId, async (client, owner) => {
        await saveHealthSourceInTransaction(client, cipher, owner, input);
        const row = await read(client, owner, input.id);
        if (!row) throw new HealthProtectionError();
        return summary(row, sourcePayload(cipher, owner, row));
      });
    },
    get(userId: string, id: string): Promise<HealthSourceRecord | null> {
      return tx(userId, async (client, owner) => {
        const row = await read(client, owner, id);
        if (!row) return null;
        const payload = sourcePayload(cipher, owner, row);
        return {
          ...summary(row, payload),
          pages: payload.pages,
          attachments: payload.attachments.map(({ sha256: _, ...meta }) => meta),
        };
      });
    },
    list(userId: string, limit = 100): Promise<HealthSourceSummary[]> {
      return tx(userId, async (client, owner) => {
        z.number().int().min(1).max(MAX_SOURCE_LIST).parse(limit);
        const rows = await client.query<SourceRow>(
          `SELECT bounded.*,r.id AS report_id FROM
          (SELECT id,revision,created_at,CASE WHEN sum(octet_length(envelope::text)) OVER () <= $3 THEN envelope ELSE NULL END AS envelope
            FROM (SELECT id,revision,created_at,envelope FROM health_secure_sources WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2) selected) bounded
          LEFT JOIN health_secure_reports r ON r.user_id=$1 AND r.source_document_id=bounded.id ORDER BY bounded.created_at DESC,bounded.id`,
          [owner, limit === MAX_SOURCE_LIST ? limit + 1 : limit, MAX_LIST_BYTES],
        );
        if (rows.rows.length > MAX_SOURCE_LIST || rows.rows.some((row) => row.envelope === null))
          throw new HealthProtectionError();
        return rows.rows.map((row) => summary(row, sourcePayload(cipher, owner, row)));
      });
    },
    attachment(userId: string, sourceId: string, attachmentId: string) {
      return tx(userId, async (client, owner) => {
        const source = await read(client, owner, sourceId);
        if (!source) return null;
        const meta = sourcePayload(cipher, owner, source).attachments.find(
          (a) => a.id === ID.parse(attachmentId),
        );
        if (!meta) return null;
        const rows = await client.query<AssetRow>(
          'SELECT id,source_id,revision,envelope FROM health_secure_assets WHERE user_id=$1 AND source_id=$2 AND id=$3',
          [owner, source.id, meta.id],
        );
        const row = rows.rows[0];
        if (!row) throw new HealthProtectionError();
        const payload = decryptHealthJson(cipher, owner, 'asset', row, AssetPayload);
        if (
          payload.sourceId !== source.id ||
          healthContentHash(attachmentMeta(payload.attachment)) !== healthContentHash(meta)
        )
          throw new HealthProtectionError();
        return { ...payload.attachment, bytes: meta.bytes };
      });
    },
    remove(userId: string, id: string): Promise<boolean> {
      return tx(userId, async (client, owner) => {
        const sourceId = ID.parse(id);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${owner}:health-source:${sourceId}`,
        ]);
        const row = await client.query(
          'SELECT id FROM health_secure_sources WHERE user_id=$1 AND id=$2 FOR UPDATE',
          [owner, sourceId],
        );
        if (!row.rowCount) return false;
        await client.query(
          'DELETE FROM health_secure_reports WHERE user_id=$1 AND source_document_id=$2',
          [owner, sourceId],
        );
        await client.query('DELETE FROM health_secure_sources WHERE user_id=$1 AND id=$2', [
          owner,
          sourceId,
        ]);
        return true;
      });
    },
    archiveLegacy(userId: string, input: HealthLegacyResourceInput) {
      return tx(userId, (client, owner) =>
        archiveHealthLegacyInTransaction(client, cipher, owner, input),
      );
    },
    legacy(userId: string, id: string) {
      return tx(userId, async (client, owner) => {
        const result = await client.query<AssetRow>(
          'SELECT id,source_id,revision,envelope FROM health_secure_legacy_resources WHERE user_id=$1 AND id=$2',
          [owner, ID.parse(id)],
        );
        const row = result.rows[0];
        if (!row) return null;
        const payload = decryptHealthJson(cipher, owner, 'legacy-resource', row, LegacyPayload);
        if (payload.sourceId !== row.source_id) throw new HealthProtectionError();
        return { id: row.id, ...payload };
      });
    },
  };
}
export type EncryptedHealthSourceStore = ReturnType<typeof createEncryptedHealthSourceStore>;
