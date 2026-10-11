import { createHash } from 'node:crypto';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';
import { type Embedder, toPgVector } from './embeddings.js';
import { normalizeContent, reciprocalRankFusion } from './rrf.js';
import type {
  MemoryHit,
  MemoryKind,
  MemoryRecord,
  Provenance,
  RememberInput,
  SearchInput,
} from './types.js';

interface Row {
  id: string;
  user_id: string;
  kind: MemoryKind;
  category: MemoryRecord['category'];
  content: string;
  tags: string[];
  provenance: Provenance;
  confidence: number;
  status: MemoryRecord['status'];
  valid_from: Date;
  valid_to: Date | null;
  episode_id: string | null;
  supersedes_id: string | null;
  seen_count: number;
  last_seen_at: Date;
  created_at: Date;
  fts_rank?: string | number | null;
  vec_rank?: string | number | null;
}

const COLS = `id, user_id, kind, category, content, tags, provenance, confidence, status, valid_from, valid_to, episode_id, supersedes_id, seen_count, last_seen_at, created_at`;

const toRecord = (r: Row): MemoryRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  category: r.category,
  content: r.content,
  tags: r.tags,
  provenance: r.provenance,
  confidence: Number(r.confidence),
  status: r.status,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  episodeId: r.episode_id,
  supersedesId: r.supersedes_id,
  seenCount: r.seen_count,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});

export interface MemoryRepositoryOptions {
  /** Similarità coseno oltre la quale un nuovo ricordo semantico è un duplicato. */
  readonly dedupSimilarity?: number;
  /** Peso della gamba testuale nella fusione RRF (vettori = 1). */
  readonly ftsWeight?: number;
  readonly logger?: Pick<Logger, 'warn' | 'debug'>;
}

export interface RememberResult {
  readonly record: MemoryRecord;
  readonly deduplicated: boolean;
  readonly superseded: boolean;
  readonly embedded: boolean;
}

export interface MemoryRepository {
  remember(input: RememberInput): Promise<RememberResult>;
  search(input: SearchInput): Promise<MemoryHit[]>;
  listActiveSemantic(userId: string, limit?: number): Promise<MemoryRecord[]>;
  getById(userId: string, id: string): Promise<MemoryRecord | null>;
  forget(userId: string, id: string): Promise<boolean>;
  forgetAll(userId: string): Promise<number>;
  exportAll(userId: string): Promise<MemoryRecord[]>;
  /** Cancellazione fisica dei ricordi `deleted` più vecchi della retention: usa un pool proprietario (attraversa gli utenti). */
  purge(ownerPool: Pool, retentionDays: number): Promise<number>;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(normalizeContent(content)).digest('hex');
}

export function createMemoryRepository(
  pool: Pool,
  embedder: Embedder,
  opts: MemoryRepositoryOptions = {},
): MemoryRepository {
  const dedupSim = opts.dedupSimilarity ?? 0.92;
  const ftsWeight = opts.ftsWeight ?? 0.3;

  async function tryEmbed(texts: string[]): Promise<number[][] | null> {
    try {
      const { vectors } = await embedder.embed(texts);
      return vectors;
    } catch (err) {
      opts.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'embedding non disponibile: solo full-text',
      );
      return null;
    }
  }

  async function bump(client: PoolClient, id: string, confidence: number): Promise<MemoryRecord> {
    const res = await client.query<Row>(
      `UPDATE memories SET seen_count = seen_count + 1, last_seen_at = now(), confidence = GREATEST(confidence, $2), updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [id, confidence],
    );
    const row = res.rows[0];
    if (!row) throw new Error('aggiornamento ricordo fallito');
    return toRecord(row);
  }

  return {
    async remember(input) {
      const content = input.content.replace(/\s+/g, ' ').trim();
      if (!content) throw new Error('contenuto vuoto');
      const hash = contentHash(content);
      const confidence = input.confidence ?? 0.7;
      const vectors = await tryEmbed([content]);
      const vector = vectors?.[0];

      return withUser(pool, input.userId, async (client) => {
        // 1) duplicato esatto (normalizzato)
        const exact = await client.query<Row>(
          `SELECT ${COLS} FROM memories WHERE user_id = $1 AND content_hash = $2 AND status = 'active'`,
          [input.userId, hash],
        );
        const exactRow = exact.rows[0];
        if (exactRow) {
          return {
            record: await bump(client, exactRow.id, confidence),
            deduplicated: true,
            superseded: false,
            embedded: Boolean(vector),
          };
        }
        // 2) quasi-duplicato semantico (solo per i fatti semantici)
        if (vector && input.kind === 'semantic') {
          const near = await client.query<{ id: string; sim: number }>(
            `SELECT id, 1 - (embedding <=> $3::vector) AS sim FROM memories
              WHERE user_id = $1 AND kind = $2 AND status = 'active' AND embedding IS NOT NULL
              ORDER BY embedding <=> $3::vector LIMIT 1`,
            [input.userId, input.kind, toPgVector(vector)],
          );
          const n = near.rows[0];
          if (n && Number(n.sim) >= dedupSim) {
            return {
              record: await bump(client, n.id, confidence),
              deduplicated: true,
              superseded: false,
              embedded: true,
            };
          }
        }
        // 3) inserimento (+ supersessione del ricordo contraddetto)
        const ins = await client.query<Row>(
          `INSERT INTO memories (user_id, kind, category, content, tags, provenance, confidence, episode_id, supersedes_id, content_hash, embedding, embedding_model, valid_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12,$13) RETURNING ${COLS}`,
          [
            input.userId,
            input.kind,
            input.category ?? null,
            content,
            [...(input.tags ?? [])],
            JSON.stringify(input.provenance),
            confidence,
            input.episodeId ?? null,
            input.supersedesId ?? null,
            hash,
            vector ? toPgVector(vector) : null,
            vector ? embedder.model : null,
            input.validFrom ?? new Date(),
          ],
        );
        const row = ins.rows[0];
        if (!row) throw new Error('inserimento ricordo fallito');
        let superseded = false;
        if (input.supersedesId) {
          const sup = await client.query(
            `UPDATE memories SET status = 'superseded', valid_to = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active'`,
            [input.supersedesId, input.userId],
          );
          superseded = (sup.rowCount ?? 0) === 1;
        }
        return {
          record: toRecord(row),
          deduplicated: false,
          superseded,
          embedded: Boolean(vector),
        };
      });
    },

    async search(input) {
      const limit = input.limit ?? 5;
      const candidates = input.candidates ?? 20;
      const kinds =
        input.kinds && input.kinds.length > 0
          ? [...input.kinds]
          : ['semantic', 'episodic', 'procedural'];
      const query = input.query.replace(/\s+/g, ' ').trim();
      if (!query) return [];
      const vectors = await tryEmbed([query]);
      const qv = vectors?.[0];

      return withUser(pool, input.userId, async (client) => {
        // Gamba testuale in OR: le domande in linguaggio naturale raramente contengono tutti i termini del fatto;
        // ts_rank_cd premia comunque i documenti che ne contengono di più.
        const fts = await client.query<Row>(
          `WITH q AS (
             SELECT to_tsquery('italian', NULLIF(replace(websearch_to_tsquery('italian', $2)::text, '&', '|'), '')) AS query
           )
           SELECT ${COLS}, row_number() OVER (ORDER BY ts_rank_cd(tsv, q.query) DESC, last_seen_at DESC) AS fts_rank
             FROM memories, q
            WHERE user_id = $1 AND status = 'active' AND kind = ANY($3::text[])
              AND (valid_to IS NULL OR valid_to > now()) AND q.query IS NOT NULL AND tsv @@ q.query
            ORDER BY ts_rank_cd(tsv, q.query) DESC, last_seen_at DESC LIMIT $4`,
          [input.userId, query, kinds, candidates],
        );
        const vec = qv
          ? await client.query<Row>(
              `SELECT ${COLS}, row_number() OVER (ORDER BY embedding <=> $2::vector) AS vec_rank
                 FROM memories
                WHERE user_id = $1 AND status = 'active' AND kind = ANY($3::text[])
                  AND (valid_to IS NULL OR valid_to > now()) AND embedding IS NOT NULL
                ORDER BY embedding <=> $2::vector LIMIT $4`,
              [input.userId, toPgVector(qv), kinds, candidates],
            )
          : { rows: [] as Row[] };
        const byId = new Map<string, Row>();
        for (const r of [...fts.rows, ...vec.rows]) {
          const prev = byId.get(r.id);
          byId.set(r.id, {
            ...(prev ?? r),
            fts_rank: prev?.fts_rank ?? r.fts_rank ?? null,
            vec_rank: prev?.vec_rank ?? r.vec_rank ?? null,
          });
        }
        const fused = reciprocalRankFusion(
          [fts.rows.map((r) => r.id), vec.rows.map((r) => r.id)],
          60,
          [ftsWeight, 1],
        );
        return [...byId.values()]
          .map(
            (r): MemoryHit => ({
              ...toRecord(r),
              score: fused.get(r.id) ?? 0,
              ftsRank: r.fts_rank === null || r.fts_rank === undefined ? null : Number(r.fts_rank),
              vecRank: r.vec_rank === null || r.vec_rank === undefined ? null : Number(r.vec_rank),
            }),
          )
          .sort((a, b) => b.score - a.score || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
          .slice(0, limit);
      });
    },

    async listActiveSemantic(userId, limit = 200) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `SELECT ${COLS} FROM memories WHERE user_id = $1 AND kind = 'semantic' AND status = 'active' AND (valid_to IS NULL OR valid_to > now())
            ORDER BY confidence DESC, last_seen_at DESC LIMIT $2`,
          [userId, limit],
        );
        return res.rows.map(toRecord);
      });
    },

    async getById(userId, id) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `SELECT ${COLS} FROM memories WHERE user_id = $1 AND id = $2`,
          [userId, id],
        );
        const row = res.rows[0];
        return row ? toRecord(row) : null;
      });
    },

    async forget(userId, id) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE memories SET status = 'deleted', expired_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND status <> 'deleted'`,
          [id, userId],
        );
        return (res.rowCount ?? 0) === 1;
      });
    },

    async forgetAll(userId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE memories SET status = 'deleted', expired_at = now(), updated_at = now() WHERE user_id = $1 AND status <> 'deleted'`,
          [userId],
        );
        return res.rowCount ?? 0;
      });
    },

    async exportAll(userId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `SELECT ${COLS} FROM memories WHERE user_id = $1 AND status <> 'deleted' ORDER BY created_at`,
          [userId],
        );
        return res.rows.map(toRecord);
      });
    },

    async purge(ownerPool, retentionDays) {
      const res = await ownerPool.query(
        `DELETE FROM memories WHERE status = 'deleted' AND expired_at < now() - ($1::int * interval '1 day')`,
        [retentionDays],
      );
      return res.rowCount ?? 0;
    },
  };
}
