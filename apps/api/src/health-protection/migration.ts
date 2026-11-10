import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from '@ernie/db';
import { z } from 'zod';
import { type HealthCipher, HealthProtectionError, MAX_HEALTH_PLAINTEXT_BYTES } from './crypto.js';
import {
  archiveHealthLegacyInTransaction,
  decryptHealthJson,
  encryptHealthJson,
  HealthSourceInput,
  healthContentHash,
  saveHealthSourceInTransaction,
} from './sources.js';
import { EncryptedHealthNoticePayload, EncryptedHealthReportPayload } from './store.js';

const ID = z.uuid().transform((s) => s.toLowerCase());
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const LIMIT = 2_000;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
type Row = Record<string, unknown>;
interface LegacyReport extends Row {
  id: string;
  document_id: string | null;
  note_path: string | null;
}
interface LegacyDocument extends Row {
  id: string;
  page_texts: unknown;
  title: string;
  source: string;
  status: string;
}
interface LegacyValue extends Row {
  id: string;
  report_id: string;
}
interface LegacyNotice extends Row {
  id: string;
  report_id: string | null;
  text: string;
}
interface LegacyMedia extends Row {
  id: string;
  ocr_text: string;
  image_bytes: Buffer;
  thumbnail_bytes: Buffer;
}
export interface HealthMigrationIssue {
  kind: 'report' | 'notice' | 'document' | 'media';
  id: string;
  code: string;
}
export interface HealthMigrationReview {
  version: 1;
  fingerprint: string;
  counts: {
    reports: number;
    values: number;
    notices: number;
    documents: number;
    exactMedia: number;
  };
  eligible: {
    reports: number;
    values: number;
    notices: number;
    documents: number;
    exactMedia: number;
  };
  blockers: HealthMigrationIssue[];
  warnings: HealthMigrationIssue[];
  copies: {
    brainNotes: number;
    brainChunks: number;
    mediaCandidates: number;
    sessions: number;
    vault: 'requires_external_inventory';
    history: 'requires_external_inventory';
    transcripts: 'requires_external_inventory';
    backups: 'requires_external_inventory';
  };
}
export interface HealthMigrationResult extends HealthMigrationReview {
  applied: boolean;
  alreadyApplied: boolean;
}
interface Snapshot {
  reports: LegacyReport[];
  values: LegacyValue[];
  notices: LegacyNotice[];
  documents: LegacyDocument[];
  chunks: Row[];
  media: LegacyMedia[];
  notes: Row[];
  brainChunks: Row[];
  sessions: Row[];
}
const isoDate = (value: unknown): string | null =>
  value === null
    ? null
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
const numeric = (value: unknown): number | null => (value === null ? null : Number(value));
const timestamp = (value: unknown): Date => {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new HealthProtectionError();
  return result;
};
/** Stable UUID mapping is namespaced by account, table and original ID. No content is embedded. */
export function healthMigrationId(userId: string, kind: string, originalId: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['ernie-health-migration-v1', ID.parse(userId), kind, originalId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function reportPayload(report: LegacyReport, values: LegacyValue[]) {
  return EncryptedHealthReportPayload.parse({
    schemaVersion: 1,
    sourceDocumentId: report.document_id,
    takenOn: isoDate(report.taken_on),
    lab: report.lab,
    kind: report.kind,
    values: values.map((v) => ({
      parameter: v.parameter,
      label: v.label,
      value: numeric(v.value),
      valueText: v.value_text,
      unit: v.unit,
      refLow: numeric(v.ref_low),
      refHigh: numeric(v.ref_high),
      refText: v.ref_text,
      flag: v.flag,
    })),
  });
}
function sourceInput(
  doc: LegacyDocument,
  attachments: z.input<typeof HealthSourceInput>['attachments'] = [],
) {
  return HealthSourceInput.parse({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    pages: doc.page_texts,
    attachments,
  });
}
async function capture(c: PoolClient, owner: string): Promise<Snapshot> {
  // READ/WRITE transactions are SERIALIZABLE. Every query is explicitly scoped in addition to RLS.
  let remaining = SNAPSHOT_BYTES;
  const bounded = async <T extends Row>(sql: string, args: unknown[]) => {
    const size = await c.query<{ bytes: string }>(
      `SELECT COALESCE(sum(pg_column_size(candidate)),0)::text AS bytes FROM (${sql}) candidate`,
      args,
    );
    remaining -= Number(size.rows[0]?.bytes ?? SNAPSHOT_BYTES + 1);
    if (remaining < 0) throw new HealthProtectionError();
    return c.query<T>(sql, args);
  };
  const reports = (
    await bounded<LegacyReport>(
      `SELECT r.*,to_char(r.taken_on,'YYYY-MM-DD') AS taken_on FROM health_reports r WHERE r.user_id=$1 AND NOT (r.kind='[protected]' AND r.taken_on IS NULL AND r.lab IS NULL AND r.document_id IS NULL AND r.note_path IS NULL AND EXISTS(SELECT 1 FROM health_secure_reports s WHERE s.user_id=r.user_id AND s.id=r.id)) ORDER BY r.id LIMIT $2`,
      [owner, LIMIT + 1],
    )
  ).rows;
  const values = (
    await bounded<LegacyValue>(
      'SELECT * FROM health_values WHERE user_id=$1 ORDER BY report_id,id LIMIT $2',
      [owner, LIMIT * 250 + 1],
    )
  ).rows;
  const notices = (
    await bounded<LegacyNotice>(
      'SELECT * FROM health_notices WHERE user_id=$1 ORDER BY id LIMIT $2',
      [owner, LIMIT * 20 + 1],
    )
  ).rows;
  if (reports.length > LIMIT || values.length > LIMIT * 250 || notices.length > LIMIT * 20)
    throw new HealthProtectionError();
  const ids = reports.flatMap((r) => (r.document_id ? [r.document_id] : []));
  const documents = (
    await bounded<LegacyDocument>(
      'SELECT * FROM documents WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [owner, ids],
    )
  ).rows;
  const chunks = (
    await bounded<Row>(
      'SELECT * FROM document_chunks WHERE user_id=$1 AND document_id=ANY($2::uuid[]) ORDER BY document_id,ordinal',
      [owner, ids],
    )
  ).rows;
  // Only explicit health note type/path or exact recorded report paths; unrelated Brain pages are untouched.
  const paths = reports.flatMap((r) => (r.note_path ? [r.note_path] : []));
  const notes = (
    await bounded<Row>(
      `SELECT * FROM brain_notes WHERE user_id=$1 AND
    (note_type='salute' OR path='Salute.md' OR path LIKE 'Salute/%' OR path=ANY($2::text[])) ORDER BY path`,
      [owner, paths],
    )
  ).rows;
  const brainChunks = (
    await bounded<Row>(
      'SELECT * FROM brain_chunks WHERE user_id=$1 AND path=ANY($2::text[]) ORDER BY path,ordinal',
      [owner, notes.map((n) => n.path)],
    )
  ).rows;
  // Candidates are exact links or exact OCR, never a medical classifier or substring similarity.
  const texts = documents
    .flatMap((d) => [d.body, ...(Array.isArray(d.page_texts) ? d.page_texts : [])])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const media = (
    await bounded<LegacyMedia>(
      `SELECT * FROM media_items WHERE user_id=$1 AND
    ((ocr_text<>'' AND ocr_text=ANY($2::text[])) OR brain_links && $3::text[]) ORDER BY id LIMIT $4`,
      [owner, texts, notes.map((n) => n.path), LIMIT + 1],
    )
  ).rows;
  if (media.length > LIMIT) throw new HealthProtectionError();
  // Session metadata only. Transcripts/replay live elsewhere and are explicitly not claimed covered.
  const sessions = (
    await bounded<Row>(
      'SELECT id,last_seen_at,closed_at FROM sessions WHERE user_id=$1 ORDER BY id LIMIT $2',
      [owner, LIMIT + 1],
    )
  ).rows;
  if (sessions.length > LIMIT) throw new HealthProtectionError();
  const snapshot = {
    reports,
    values,
    notices,
    documents,
    chunks,
    media,
    notes,
    brainChunks,
    sessions,
  };
  return snapshot;
}
function grouped<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = groups.get(id);
    if (bucket) bucket.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}
function plan(owner: string, snapshot: Snapshot) {
  const blockers: HealthMigrationIssue[] = [];
  const warnings: HealthMigrationIssue[] = [];
  const reportIds = new Set(snapshot.reports.map((r) => r.id));
  const valuesByReport = grouped(snapshot.values, (v) => v.report_id);
  const chunksByDocument = grouped(snapshot.chunks, (v) => String(v.document_id));
  const documentsById = new Map(snapshot.documents.map((d) => [d.id, d]));
  const eligibleReports: LegacyReport[] = [];
  const eligibleDocs = new Map<string, LegacyDocument>();
  const deletedDocs = new Map<string, LegacyDocument>();
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value)) + 4096 <= MAX_HEALTH_PLAINTEXT_BYTES;
  for (const r of snapshot.reports) {
    try {
      const values = valuesByReport.get(r.id) ?? [];
      const payload = reportPayload(r, values);
      if (!fits(payload) || !fits({ report: r, values })) throw new HealthProtectionError();
    } catch {
      blockers.push({ kind: 'report', id: r.id, code: 'invalid_legacy_payload' });
      continue;
    }
    if (r.document_id) {
      const doc = documentsById.get(r.document_id);
      if (!doc) {
        blockers.push({ kind: 'report', id: r.id, code: 'source_missing_or_not_owned' });
        continue;
      }
      if (
        doc.status === 'deleted' &&
        !doc.body &&
        Array.isArray(doc.page_texts) &&
        doc.page_texts.length === 0
      ) {
        if (!fits({ document: doc, chunks: chunksByDocument.get(doc.id) ?? [] })) {
          blockers.push({ kind: 'document', id: doc.id, code: 'oversize_deleted_derivatives' });
          continue;
        }
        deletedDocs.set(doc.id, doc);
        warnings.push({ kind: 'report', id: r.id, code: 'original_unavailable' });
      } else {
        try {
          sourceInput(doc);
          if (
            !fits({
              document: doc,
              chunks: chunksByDocument.get(doc.id) ?? [],
            })
          )
            throw new HealthProtectionError();
          eligibleDocs.set(doc.id, doc);
        } catch {
          blockers.push({ kind: 'document', id: doc.id, code: 'invalid_or_oversize_original' });
          continue;
        }
      }
    } else warnings.push({ kind: 'report', id: r.id, code: 'original_unavailable' });
    eligibleReports.push(r);
  }
  for (const value of snapshot.values)
    if (!reportIds.has(value.report_id))
      blockers.push({
        kind: 'report',
        id: value.report_id,
        code: 'unowned_or_missing_report_values',
      });
  const eligibleIds = new Set(eligibleReports.map((r) => r.id));
  const eligibleNotices: LegacyNotice[] = [];
  for (const n of snapshot.notices) {
    if (n.report_id && !eligibleIds.has(n.report_id)) {
      blockers.push({ kind: 'notice', id: String(n.id), code: 'report_not_migratable' });
      continue;
    }
    try {
      EncryptedHealthNoticePayload.parse({ schemaVersion: 1, reportId: n.report_id, text: n.text });
      if (!fits(n)) throw new HealthProtectionError();
    } catch {
      blockers.push({ kind: 'notice', id: String(n.id), code: 'invalid_legacy_payload' });
      continue;
    }
    eligibleNotices.push(n);
  }
  const exactMedia: Array<{ media: LegacyMedia; sourceId: string }> = [];
  for (const m of snapshot.media) {
    const matches = [...eligibleDocs.values()].filter(
      (d) =>
        m.ocr_text.trim().length > 0 &&
        (m.ocr_text === d.body ||
          (Array.isArray(d.page_texts) && d.page_texts.includes(m.ocr_text))),
    );
    if (
      matches.length === 1 &&
      matches[0] &&
      exactMedia.filter((item) => item.sourceId === matches[0]?.id).length < 10
    ) {
      const next = [
        ...exactMedia.filter((item) => item.sourceId === matches[0]?.id).map((item) => item.media),
        m,
      ];
      const encodedBytes = Buffer.byteLength(
        JSON.stringify(
          sourceInput(
            matches[0],
            next.map((media) => ({
              id: media.id,
              name: `originale-${media.id}.jpg`,
              mimeType: 'image/jpeg',
              dataBase64: media.image_bytes.toString('base64'),
            })),
          ),
        ),
      );
      if (encodedBytes <= 32 * 1024 * 1024) exactMedia.push({ media: m, sourceId: matches[0].id });
      else warnings.push({ kind: 'media', id: m.id, code: 'oversize_media_preserved' });
    } else warnings.push({ kind: 'media', id: m.id, code: 'ambiguous_or_excess_media_preserved' });
  }
  const countValues = (ids: Set<string>) =>
    snapshot.values.filter((v) => ids.has(v.report_id)).length;
  const review: HealthMigrationReview = {
    version: 1,
    fingerprint: healthContentHash({ domain: 'ernie-health-migration-v1', owner, snapshot }),
    counts: {
      reports: snapshot.reports.length,
      values: snapshot.values.length,
      notices: snapshot.notices.length,
      documents: snapshot.documents.length,
      exactMedia: exactMedia.length,
    },
    eligible: {
      reports: eligibleReports.length,
      values: countValues(eligibleIds),
      notices: eligibleNotices.length,
      documents: eligibleDocs.size,
      exactMedia: exactMedia.length,
    },
    blockers,
    warnings,
    copies: {
      brainNotes: snapshot.notes.length,
      brainChunks: snapshot.brainChunks.length,
      mediaCandidates: snapshot.media.length,
      sessions: snapshot.sessions.length,
      vault: 'requires_external_inventory',
      history: 'requires_external_inventory',
      transcripts: 'requires_external_inventory',
      backups: 'requires_external_inventory',
    },
  };
  return {
    review,
    eligibleReports,
    eligibleDocs: [...eligibleDocs.values()],
    eligibleNotices,
    exactMedia,
    valuesByReport,
    chunksByDocument,
    deletedDocs: [...deletedDocs.values()],
  };
}
const ReviewCounts = z
  .object({
    reports: z.number().int().nonnegative(),
    values: z.number().int().nonnegative(),
    notices: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    exactMedia: z.number().int().nonnegative(),
  })
  .strict();
const ReviewIssue = z
  .object({
    kind: z.enum(['report', 'notice', 'document', 'media']),
    id: z.string(),
    code: z.string(),
  })
  .strict();
const ReviewPayload = z
  .object({
    version: z.literal(1),
    fingerprint: HASH,
    counts: ReviewCounts,
    eligible: ReviewCounts,
    blockers: z.array(ReviewIssue),
    warnings: z.array(ReviewIssue),
    copies: z
      .object({
        brainNotes: z.number().int().nonnegative(),
        brainChunks: z.number().int().nonnegative(),
        mediaCandidates: z.number().int().nonnegative(),
        sessions: z.number().int().nonnegative(),
        vault: z.literal('requires_external_inventory'),
        history: z.literal('requires_external_inventory'),
        transcripts: z.literal('requires_external_inventory'),
        backups: z.literal('requires_external_inventory'),
      })
      .strict(),
  })
  .strict();
const RecordRow = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: z.null(),
    kind: z.literal('migration'),
    originalId: HASH,
    contents: ReviewPayload,
  })
  .strict();
interface CipherRow {
  id: string;
  revision: number;
  envelope: unknown;
}
async function verifiedInsert(
  c: PoolClient,
  cipher: HealthCipher,
  owner: string,
  kind: 'report' | 'notice',
  id: string,
  payload: unknown,
  createdAt: unknown,
  notifiedAt?: unknown,
) {
  const encrypted = encryptHealthJson(cipher, owner, kind, id, payload);
  if (kind === 'report') {
    const p = EncryptedHealthReportPayload.parse(payload);
    await c.query(
      `INSERT INTO health_secure_reports(id,user_id,source_document_id,envelope,created_at) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(id) DO NOTHING`,
      [id, owner, p.sourceDocumentId, JSON.stringify(encrypted), timestamp(createdAt)],
    );
  } else {
    const p = EncryptedHealthNoticePayload.parse(payload);
    await c.query(
      `INSERT INTO health_secure_notices(id,user_id,report_id,envelope,created_at,notified_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)
      ON CONFLICT(id) DO NOTHING`,
      [
        id,
        owner,
        p.reportId,
        JSON.stringify(encrypted),
        timestamp(createdAt),
        notifiedAt ? timestamp(notifiedAt) : null,
      ],
    );
  }
  const table = kind === 'report' ? 'health_secure_reports' : 'health_secure_notices';
  const read = await c.query<
    CipherRow & {
      source_document_id?: string | null;
      report_id?: string | null;
      created_at: Date;
      notified_at?: Date | null;
    }
  >(`SELECT * FROM ${table} WHERE user_id=$1 AND id=$2`, [owner, id]);
  const row = read.rows[0];
  if (!row || row.created_at.getTime() !== timestamp(createdAt).getTime())
    throw new HealthProtectionError();
  if (
    kind === 'notice' &&
    (row.notified_at?.getTime() ?? null) !== (notifiedAt ? timestamp(notifiedAt).getTime() : null)
  )
    throw new HealthProtectionError();
  const actual =
    kind === 'report'
      ? decryptHealthJson(cipher, owner, kind, row, EncryptedHealthReportPayload)
      : decryptHealthJson(cipher, owner, kind, row, EncryptedHealthNoticePayload);
  if (healthContentHash(actual) !== healthContentHash(payload)) throw new HealthProtectionError();
  if (
    kind === 'report' &&
    row.source_document_id !== (payload as { sourceDocumentId: string | null }).sourceDocumentId
  )
    throw new HealthProtectionError();
  if (kind === 'notice' && row.report_id !== (payload as { reportId: string | null }).reportId)
    throw new HealthProtectionError();
}

/**
 * No model, consent grant, generic search or filesystem deletion. Default run is read-only.
 * Cutover must disable legacy writers first; a transaction cannot stop old code writing after commit.
 * Uncertain rows are retained and reported; Brain/vault/history/transcripts/backups remain separate work.
 */
export function createHealthMigration(pool: Pool, cipher: HealthCipher) {
  const transaction = async <T>(
    userId: string,
    readOnly: boolean,
    work: (c: PoolClient, owner: string) => Promise<T>,
  ): Promise<T> => {
    let c: PoolClient | undefined;
    try {
      const owner = ID.parse(userId);
      c = await pool.connect();
      await c.query(`BEGIN ISOLATION LEVEL SERIALIZABLE${readOnly ? ' READ ONLY' : ''}`);
      await c.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      if (!readOnly)
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${owner}:health-migration`,
        ]);
      const result = await work(c, owner);
      await c.query('COMMIT');
      return result;
    } catch {
      try {
        await c?.query('ROLLBACK');
      } catch {}
      throw new HealthProtectionError();
    } finally {
      c?.release();
    }
  };
  const dryRun = (userId: string) =>
    transaction(userId, true, async (c, owner) => plan(owner, await capture(c, owner)).review);
  const apply = (userId: string, fingerprint: string) =>
    transaction(userId, false, async (c, owner): Promise<HealthMigrationResult> => {
      HASH.parse(fingerprint);
      const receiptId = healthMigrationId(owner, 'migration', fingerprint);
      const receipt = (
        await c.query<CipherRow>(
          'SELECT id,revision,envelope FROM health_secure_legacy_resources WHERE user_id=$1 AND id=$2',
          [owner, receiptId],
        )
      ).rows[0];
      if (receipt) {
        const payload = decryptHealthJson(cipher, owner, 'legacy-resource', receipt, RecordRow);
        if (payload.originalId !== fingerprint) throw new HealthProtectionError();
        return {
          ...payload.contents,
          applied: true,
          alreadyApplied: true,
        };
      }
      const snapshot = await capture(c, owner);
      const proposed = plan(owner, snapshot);
      if (proposed.review.fingerprint !== fingerprint) throw new HealthProtectionError();
      for (const doc of proposed.deletedDocs) {
        await c.query('SELECT id FROM documents WHERE user_id=$1 AND id=$2 FOR UPDATE', [
          owner,
          doc.id,
        ]);
        await archiveHealthLegacyInTransaction(c, cipher, owner, {
          id: healthMigrationId(owner, 'document', doc.id),
          sourceId: null,
          kind: 'document',
          originalId: doc.id,
          contents: { document: doc, chunks: proposed.chunksByDocument.get(doc.id) ?? [] },
        });
      }
      for (const doc of proposed.eligibleDocs) {
        // Lock the document before derivatives: same ordering as repository.remove/index.
        await c.query('SELECT id FROM documents WHERE user_id=$1 AND id=$2 FOR UPDATE', [
          owner,
          doc.id,
        ]);
        await saveHealthSourceInTransaction(
          c,
          cipher,
          owner,
          sourceInput(
            doc,
            proposed.exactMedia
              .filter((m) => m.sourceId === doc.id)
              .map(({ media }) => ({
                id: media.id,
                name: `originale-${media.id}.jpg`,
                mimeType: 'image/jpeg',
                dataBase64: media.image_bytes.toString('base64'),
              })),
          ),
          timestamp(doc.created_at),
        );
        await archiveHealthLegacyInTransaction(c, cipher, owner, {
          id: healthMigrationId(owner, 'document', doc.id),
          sourceId: doc.id,
          kind: 'document',
          originalId: doc.id,
          contents: {
            document: doc,
            chunks: proposed.chunksByDocument.get(doc.id) ?? [],
          },
        });
        await saveHealthSourceInTransaction(
          c,
          cipher,
          owner,
          sourceInput(
            doc,
            proposed.exactMedia
              .filter((m) => m.sourceId === doc.id)
              .map(({ media }) => ({
                id: media.id,
                name: `originale-${media.id}.jpg`,
                mimeType: 'image/jpeg',
                dataBase64: media.image_bytes.toString('base64'),
              })),
          ),
        );
        // This explicit round trip verifies the new canonical source too before touching plaintext.
        const source = (
          await c.query<CipherRow>(
            'SELECT id,revision,envelope FROM health_secure_sources WHERE user_id=$1 AND id=$2',
            [owner, doc.id],
          )
        ).rows[0];
        if (!source) throw new HealthProtectionError();
        const restored = decryptHealthJson(
          cipher,
          owner,
          'source',
          source,
          z
            .object({ title: z.string(), source: z.string(), pages: z.array(z.string()) })
            .passthrough(),
        );
        if (
          healthContentHash([restored.title, restored.source, restored.pages]) !==
          healthContentHash([doc.title, doc.source, doc.page_texts])
        )
          throw new HealthProtectionError();
      }
      for (const r of proposed.eligibleReports) {
        const values = proposed.valuesByReport.get(r.id) ?? [];
        const sourceId = proposed.eligibleDocs.some((d) => d.id === r.document_id)
          ? r.document_id
          : null;
        await archiveHealthLegacyInTransaction(c, cipher, owner, {
          id: healthMigrationId(owner, 'report', r.id),
          sourceId,
          kind: 'report',
          originalId: r.id,
          contents: { report: r, values },
        });
        await verifiedInsert(
          c,
          cipher,
          owner,
          'report',
          r.id,
          reportPayload(r, values),
          r.created_at,
        );
      }
      for (const n of proposed.eligibleNotices) {
        const id = healthMigrationId(owner, 'notice', String(n.id));
        const r = proposed.eligibleReports.find((r) => r.id === n.report_id);
        const sourceId =
          r && proposed.eligibleDocs.some((d) => d.id === r.document_id) ? r.document_id : null;
        await archiveHealthLegacyInTransaction(c, cipher, owner, {
          id: healthMigrationId(owner, 'legacy-notice', String(n.id)),
          sourceId,
          kind: 'notice',
          originalId: String(n.id),
          contents: n,
        });
        await verifiedInsert(
          c,
          cipher,
          owner,
          'notice',
          id,
          { schemaVersion: 1, reportId: n.report_id, text: n.text },
          n.created_at,
          n.notified_at,
        );
      }
      for (const { media, sourceId } of proposed.exactMedia) {
        const { image_bytes, thumbnail_bytes, ...metadata } = media;
        await archiveHealthLegacyInTransaction(c, cipher, owner, {
          id: healthMigrationId(owner, 'media', media.id),
          sourceId,
          kind: 'media',
          originalId: media.id,
          contents: {
            ...metadata,
            imageBase64: image_bytes.toString('base64'),
            thumbnailBase64: thumbnail_bytes.toString('base64'),
          },
        });
      }
      // Deletions only after every new encrypted record has passed exact authenticated read-back.
      const noticeIds = proposed.eligibleNotices.map((n) => String(n.id));
      const reportIds = proposed.eligibleReports.map((r) => r.id);
      for (const doc of [...proposed.eligibleDocs, ...proposed.deletedDocs]) {
        await c.query('DELETE FROM document_chunks WHERE user_id=$1 AND document_id=$2', [
          owner,
          doc.id,
        ]);
        await c.query(
          `UPDATE documents SET status='deleted',title='Documento protetto',language=NULL,chars=0,
        page_texts='[]'::jsonb,body='',products=NULL,schemas='{}'::jsonb,updated_at=now() WHERE user_id=$1 AND id=$2`,
          [owner, doc.id],
        );
      }
      await c.query('DELETE FROM health_notices WHERE user_id=$1 AND id=ANY($2::bigint[])', [
        owner,
        noticeIds,
      ]);
      await c.query('DELETE FROM health_values WHERE user_id=$1 AND report_id=ANY($2::uuid[])', [
        owner,
        reportIds,
      ]);
      // Legacy child FKs omit user_id. A tombstone avoids cascading into corrupt cross-account
      // children that RLS deliberately does not let this account inspect or delete.
      await c.query(
        `UPDATE health_reports SET taken_on=NULL,lab=NULL,kind='[protected]',document_id=NULL,note_path=NULL WHERE user_id=$1 AND id=ANY($2::uuid[])`,
        [owner, reportIds],
      );
      const mediaIds = proposed.exactMedia.map(({ media }) => media.id);
      await c.query('DELETE FROM media_items WHERE user_id=$1 AND id=ANY($2::uuid[])', [
        owner,
        mediaIds,
      ]);
      // The media DELETE trigger enqueues resources; remove those exact obsolete jobs, not other work.
      await c.query(
        "DELETE FROM brain_resource_queue WHERE user_id=$1 AND kind='media' AND resource_id=ANY($2::uuid[])",
        [owner, mediaIds],
      );
      await archiveHealthLegacyInTransaction(c, cipher, owner, {
        id: receiptId,
        sourceId: null,
        kind: 'migration',
        originalId: fingerprint,
        contents: proposed.review,
      });
      return { ...proposed.review, applied: true, alreadyApplied: false };
    });
  return {
    dryRun,
    apply,
    run(userId: string, options?: { apply: true; fingerprint: string }) {
      return options?.apply ? apply(userId, options.fingerprint) : dryRun(userId);
    },
  };
}
