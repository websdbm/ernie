import { randomUUID } from 'node:crypto';
import type { HealthReportSummary, HealthStore, SeriesPoint } from '@ernie/brain';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import { z } from 'zod';
import { type HealthCipher, HealthProtectionError } from './crypto.js';

/** Aggregation decrypts a complete account archive; larger archives fail instead of returning partial facts. */
export const HEALTH_SECURE_REPORT_LIMIT = 2_000;
const MAX_ARCHIVE_ENVELOPE_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const ID = z.uuid().transform((value) => value.toLowerCase());
const Value = z
  .object({
    parameter: z.string().min(1),
    label: z.string().min(1),
    value: z.number().finite().nullable(),
    valueText: z.string().nullable(),
    unit: z.string().nullable(),
    refLow: z.number().finite().nullable(),
    refHigh: z.number().finite().nullable(),
    refText: z.string().nullable(),
    flag: z.enum(['alto', 'basso', 'normale', 'n/d']),
  })
  .strict();

/** Shared with the future migration, never stored as plaintext JSON. */
export const EncryptedHealthReportPayload = z
  .object({
    schemaVersion: z.literal(1),
    sourceDocumentId: ID.nullable(),
    takenOn: z.iso.date().nullable(),
    lab: z.string().nullable(),
    kind: z.string().min(1),
    values: z.array(Value).max(250),
  })
  .strict();
export const EncryptedHealthNoticePayload = z
  .object({ schemaVersion: z.literal(1), reportId: ID.nullable(), text: z.string() })
  .strict();
type ReportPayload = z.infer<typeof EncryptedHealthReportPayload>;

export interface EncryptedHealthStoreOptions {
  /** Called in the same transaction before any mutation. May lock/check a consent revision lease. */
  readonly guardWrite?: (userId: string, client: PoolClient) => Promise<void>;
}

interface ReportRow {
  id: string;
  source_document_id: string | null;
  revision: number;
  envelope: unknown;
  created_at: Date;
}
interface Report {
  id: string;
  createdAt: number;
  payload: ReportPayload;
}
const summary = (report: Report): HealthReportSummary => ({
  id: report.id,
  takenOn: report.payload.takenOn,
  lab: report.payload.lab,
  kind: report.payload.kind,
  notePath: null,
  values: report.payload.values.length,
  outOfRange: report.payload.values.filter(
    (value) => value.flag === 'alto' || value.flag === 'basso',
  ).length,
});
const byDate = (a: Report, b: Report): number => {
  const left = a.payload.takenOn;
  const right = b.payload.takenOn;
  const date =
    left === right ? 0 : left === null ? -1 : right === null ? 1 : left.localeCompare(right);
  return date || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
};
const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch {
    // Schema, crypto, database and guard errors must not leak medical payloads or SQL arguments.
    throw new HealthProtectionError();
  }
};

/**
 * HealthStore backed only by the encrypted tables. No legacy fallback and no vault access.
 * Manual reads do not depend on AI consent; callers must enforce their own authenticated read scopes.
 * Every write checks guardWrite inside withUser, before changing a row. Nothing invokes a model here.
 */
export function createEncryptedHealthStore(
  pool: Pool,
  cipher: HealthCipher,
  options: EncryptedHealthStoreOptions = {},
): HealthStore {
  const transaction = <T>(
    userId: string,
    write: boolean,
    operation: (client: PoolClient, owner: string) => Promise<T>,
  ) =>
    safe(async () => {
      const owner = ID.parse(userId);
      return withUser(pool, owner, async (client) => {
        if (write) await options.guardWrite?.(owner, client);
        return operation(client, owner);
      });
    });

  const decrypt = <T>(
    owner: string,
    kind: 'report' | 'notice',
    row: { id: string; revision: number; envelope: unknown },
    schema: z.ZodType<T>,
  ): T => {
    const bytes = cipher.decrypt(
      { userId: owner, resourceKind: kind, resourceId: row.id, resourceVersion: row.revision },
      row.envelope,
    );
    try {
      return schema.parse(JSON.parse(UTF8.decode(bytes)));
    } finally {
      bytes.fill(0);
    }
  };
  const report = (owner: string, row: ReportRow): Report => {
    const payload = decrypt(owner, 'report', row, EncryptedHealthReportPayload);
    // Bind associations as well: source IDs outside the envelope exist only for lookup/uniqueness.
    if (payload.sourceDocumentId !== row.source_document_id) throw new HealthProtectionError();
    return { id: row.id, createdAt: row.created_at.getTime(), payload };
  };
  const allReports = async (client: PoolClient, owner: string): Promise<Report[]> => {
    const result = await client.query<ReportRow>(
      `SELECT id,source_document_id,revision,created_at,
         CASE WHEN sum(octet_length(envelope::text)) OVER () <= $3 THEN envelope ELSE NULL END AS envelope
       FROM (SELECT id,source_document_id,revision,envelope,created_at FROM health_secure_reports
         WHERE user_id=$1 ORDER BY created_at,id LIMIT $2) bounded`,
      [owner, HEALTH_SECURE_REPORT_LIMIT + 1, MAX_ARCHIVE_ENVELOPE_BYTES],
    );
    if (
      result.rows.length > HEALTH_SECURE_REPORT_LIMIT ||
      result.rows.some((row) => row.envelope === null)
    )
      throw new HealthProtectionError();
    return result.rows.map((row) => report(owner, row));
  };
  const oneReport = async (client: PoolClient, owner: string, id: string) => {
    const result = await client.query<ReportRow>(
      `SELECT id,source_document_id,revision,envelope,created_at FROM health_secure_reports
       WHERE user_id=$1 AND id=$2`,
      [owner, ID.parse(id)],
    );
    return result.rows[0] ? report(owner, result.rows[0]) : null;
  };

  return {
    saveReport(userId, input, values) {
      return transaction(userId, true, async (client, owner) => {
        const payload = EncryptedHealthReportPayload.parse({
          schemaVersion: 1,
          sourceDocumentId: input.documentId ?? null,
          takenOn: input.takenOn,
          lab: input.lab,
          kind: input.kind,
          values,
        });
        const id = randomUUID();
        const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
        let encrypted: ReturnType<HealthCipher['encrypt']>;
        try {
          encrypted = cipher.encrypt(
            { userId: owner, resourceKind: 'report', resourceId: id, resourceVersion: 1 },
            bytes,
          );
        } finally {
          bytes.fill(0);
        }
        const result = await client.query<{ id: string }>(
          `INSERT INTO health_secure_reports (id,user_id,source_document_id,revision,envelope)
           VALUES ($1,$2,$3,1,$4::jsonb)
           ON CONFLICT (user_id,source_document_id) DO NOTHING RETURNING id`,
          [id, owner, payload.sourceDocumentId, JSON.stringify(encrypted)],
        );
        return result.rows[0]?.id ?? null;
      });
    },
    setNotePath(userId, reportId, path) {
      return safe(async () => {
        ID.parse(userId);
        ID.parse(reportId);
        // An empty compatibility call does nothing. In particular, no new Markdown path is accepted.
        if (path !== '') throw new HealthProtectionError();
      });
    },
    reports(userId, limit = 20) {
      return transaction(userId, false, async (client, owner) => {
        z.number().int().min(0).max(HEALTH_SECURE_REPORT_LIMIT).parse(limit);
        return (await allReports(client, owner))
          .sort((a, b) => byDate(b, a))
          .slice(0, limit)
          .map(summary);
      });
    },
    report(userId, reportId) {
      return transaction(userId, false, async (client, owner) => {
        const found = await oneReport(client, owner, reportId);
        return found ? summary(found) : null;
      });
    },
    reportValues(userId, reportId) {
      return transaction(userId, false, async (client, owner) => {
        const found = await oneReport(client, owner, reportId);
        return (found?.payload.values ?? []).sort((a, b) => a.label.localeCompare(b.label, 'it'));
      });
    },
    series(userId, parameter) {
      return transaction(userId, false, async (client, owner) => {
        const key = z.string().min(1).parse(parameter);
        return (await allReports(client, owner)).sort(byDate).flatMap((entry) =>
          entry.payload.values
            .filter((value) => value.parameter === key)
            .map(
              (value): SeriesPoint => ({
                date: entry.payload.takenOn,
                value: value.value,
                valueText: value.valueText,
                unit: value.unit,
                flag: value.flag,
                refLow: value.refLow,
                refHigh: value.refHigh,
              }),
            ),
        );
      });
    },
    parameters(userId) {
      return transaction(userId, false, async (client, owner) => {
        const parameters = new Map<string, { parameter: string; label: string; count: number }>();
        for (const report of await allReports(client, owner)) {
          for (const value of report.payload.values) {
            const known = parameters.get(value.parameter);
            if (known) {
              known.count++;
              if (value.label > known.label) known.label = value.label;
            } else
              parameters.set(value.parameter, {
                parameter: value.parameter,
                label: value.label,
                count: 1,
              });
          }
        }
        return [...parameters.values()].sort((a, b) => a.label.localeCompare(b.label, 'it'));
      });
    },
    addNotices(userId, reportId, texts) {
      if (!texts.length) return Promise.resolve();
      return transaction(userId, true, async (client, owner) => {
        const related = reportId === null ? null : ID.parse(reportId);
        for (const text of texts) {
          const payload = EncryptedHealthNoticePayload.parse({
            schemaVersion: 1,
            reportId: related,
            text,
          });
          const id = randomUUID();
          const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
          let encrypted: ReturnType<HealthCipher['encrypt']>;
          try {
            encrypted = cipher.encrypt(
              { userId: owner, resourceKind: 'notice', resourceId: id, resourceVersion: 1 },
              bytes,
            );
          } finally {
            bytes.fill(0);
          }
          await client.query(
            `INSERT INTO health_secure_notices (id,user_id,report_id,revision,envelope)
             VALUES ($1,$2,$3,1,$4::jsonb)`,
            [id, owner, related, JSON.stringify(encrypted)],
          );
        }
      });
    },
    supersedeNotices(userId, keepReportId) {
      return transaction(userId, true, async (client, owner) => {
        // A mistyped/foreign reference must never mark every notice in this account as obsolete.
        if (!(await oneReport(client, owner, keepReportId))) throw new HealthProtectionError();
        await client.query(
          `UPDATE health_secure_notices SET notified_at=now()
           WHERE user_id=$1 AND notified_at IS NULL AND report_id IS NOT NULL AND report_id<>$2`,
          [owner, ID.parse(keepReportId)],
        );
      });
    },
    pendingNotices(userId) {
      return transaction(userId, false, async (client, owner) => {
        const result = await client.query<{
          id: string;
          report_id: string | null;
          revision: number;
          envelope: unknown;
        }>(
          `SELECT id,report_id,revision,envelope FROM health_secure_notices
           WHERE user_id=$1 AND notified_at IS NULL ORDER BY created_at,id LIMIT 20`,
          [owner],
        );
        return result.rows.map((row) => {
          const payload = decrypt(owner, 'notice', row, EncryptedHealthNoticePayload);
          if (payload.reportId !== row.report_id) throw new HealthProtectionError();
          return { id: row.id, text: payload.text };
        });
      });
    },
    markNotified(userId, ids) {
      if (!ids.length) return Promise.resolve();
      return transaction(userId, true, async (client, owner) => {
        const unique = [...new Set(z.array(ID).parse(ids))];
        await client.query(
          `UPDATE health_secure_notices SET notified_at=now()
           WHERE user_id=$1 AND id=ANY($2::uuid[]) AND notified_at IS NULL`,
          [owner, unique],
        );
      });
    },
    hasDocument(userId, documentId) {
      return transaction(userId, false, async (client, owner) => {
        const result = await client.query(
          `SELECT 1 FROM health_secure_reports WHERE user_id=$1 AND source_document_id=$2`,
          [owner, ID.parse(documentId)],
        );
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
