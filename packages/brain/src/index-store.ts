import { createHash } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';
import type { BrainNote, NoteType } from './note.js';

/** Embedder (stessa interfaccia dei documenti): null = solo full-text. */
export interface BrainEmbedder {
  readonly model: string;
  embed(texts: string[]): Promise<{ vectors: number[][] }>;
}

export interface NoteSummary {
  readonly path: string;
  readonly title: string;
  readonly type: NoteType;
  readonly created: string;
  readonly refersFrom: string | null;
  readonly refersTo: string | null;
  readonly place: string | null;
  readonly coords: readonly [number, number] | null;
  readonly links: readonly string[];
  readonly private: boolean;
  readonly source: string | null;
  readonly excerpt: string;
}

export interface BrainHit extends NoteSummary {
  /** Il pezzo più pertinente della nota. */
  readonly passage: string;
  readonly heading: string | null;
  readonly score: number;
}

export interface BrainQuery {
  readonly query?: string | undefined;
  readonly type?: NoteType | undefined;
  /** Note che si riferiscono a date in questo intervallo (o create in esso, se senza data). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Luogo: nome (contiene) oppure vicino a coordinate entro `radiusKm`. */
  readonly place?: string | undefined;
  readonly near?: readonly [number, number] | undefined;
  readonly radiusKm?: number | undefined;
  /** Collegate a questa nota (per titolo). */
  readonly linkedTo?: string | undefined;
  readonly includePrivate?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface BrainIndex {
  upsert(userId: string, note: BrainNote): Promise<boolean>;
  remove(userId: string, path: string): Promise<void>;
  search(userId: string, q: BrainQuery): Promise<BrainHit[]>;
  list(userId: string, q?: BrainQuery): Promise<NoteSummary[]>;
  get(userId: string, path: string): Promise<NoteSummary | null>;
  /** Trova una nota per titolo (senza maiuscole) o percorso. */
  findByTitle(userId: string, title: string): Promise<NoteSummary | null>;
  count(userId: string): Promise<number>;
  paths(userId: string): Promise<Map<string, string>>;
  /**
   * Nota da suggerire in conversazione (fase B2): solo full-text, senza modello. Vale se almeno due parole
   * significative della frase compaiono nella stessa nota e coprono almeno il 40 % della frase (o se il titolo
   * della nota è contenuto per intero nella frase). Mai le riservate né «Chi sono».
   */
  suggest(
    userId: string,
    text: string,
    exclude?: readonly string[],
  ): Promise<BrainSuggestion | null>;
}

export interface BrainSuggestion {
  readonly path: string;
  readonly title: string;
  readonly type: NoteType;
  readonly when: string;
  readonly passage: string;
  readonly matched: number;
}

const MAX_CHARS = 1_200;

/** Pezzi della nota: per titoletti markdown e paragrafi, ~1.200 caratteri, con il titoletto corrente. */
export function chunkNote(
  note: Pick<BrainNote, 'title' | 'body'>,
): Array<{ heading: string | null; content: string }> {
  const out: Array<{ heading: string | null; content: string }> = [];
  let heading: string | null = null;
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ heading, content: t });
    buf = '';
  };
  for (const para of note.body.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    const h = /^#{1,6}\s+(.+)$/.exec(p.split('\n')[0] ?? '');
    if (h) {
      flush();
      heading = (h[1] ?? '').trim().slice(0, 120);
      const rest = p.split('\n').slice(1).join('\n').trim();
      if (rest) buf = rest;
      continue;
    }
    if (buf.length + p.length > MAX_CHARS) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
    while (buf.length > MAX_CHARS * 1.5) {
      out.push({ heading, content: buf.slice(0, MAX_CHARS) });
      buf = buf.slice(MAX_CHARS);
    }
  }
  flush();
  if (!out.length) out.push({ heading: null, content: note.title });
  return out;
}

const vec = (v: readonly number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

export const noteHash = (n: BrainNote) =>
  createHash('sha256')
    .update(JSON.stringify({ ...n, path: undefined }))
    .digest('hex');

type Row = {
  path: string;
  title: string;
  note_type: NoteType;
  created: Date;
  refers_from: string | null;
  refers_to: string | null;
  place: string | null;
  lat: number | null;
  lon: number | null;
  links: string[];
  private: boolean;
  source: string | null;
  excerpt: string;
};

const COLS = `n.path, n.title, n.note_type, n.created, to_char(n.refers_from,'YYYY-MM-DD') AS refers_from,
  to_char(n.refers_to,'YYYY-MM-DD') AS refers_to, n.place, n.lat, n.lon, n.links, n.private, n.source, n.excerpt`;

const summary = (r: Row): NoteSummary => ({
  path: r.path,
  title: r.title,
  type: r.note_type,
  created: r.created.toISOString(),
  refersFrom: r.refers_from,
  refersTo: r.refers_to,
  place: r.place,
  coords: r.lat !== null && r.lon !== null ? [r.lat, r.lon] : null,
  links: r.links,
  private: r.private,
  source: r.source,
  excerpt: r.excerpt,
});

/** Filtri comuni a elenco e ricerca: parametri da `start` in poi. */
function filters(q: BrainQuery, start: number): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${start + params.length - 1}`;
  };
  if (!q.includePrivate) parts.push('n.private = false');
  if (q.type) parts.push(`n.note_type = ${p(q.type)}`);
  if (q.from)
    parts.push(`coalesce(n.refers_to, n.refers_from, n.created::date) >= ${p(q.from)}::date`);
  if (q.to) parts.push(`coalesce(n.refers_from, n.created::date) <= ${p(q.to)}::date`);
  if (q.place) parts.push(`n.place ILIKE ${p(`%${q.place.replace(/[%_]/g, '')}%`)}`);
  if (q.near) {
    // Distanza approssimata (equirettangolare): basta per «vicino a» entro qualche km.
    const lat = p(q.near[0]);
    const lon = p(q.near[1]);
    const r = p(q.radiusKm ?? 5);
    parts.push(
      `n.lat IS NOT NULL AND sqrt(power((n.lat - ${lat}) * 111.0, 2) + power((n.lon - ${lon}) * 111.0 * cos(radians(${lat})), 2)) <= ${r}`,
    );
  }
  if (q.linkedTo) {
    const t = p(q.linkedTo.toLowerCase());
    parts.push(
      `(EXISTS (SELECT 1 FROM unnest(n.links) l WHERE lower(l) = ${t}) OR lower(n.title) = ${t})`,
    );
  }
  return { sql: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

export function createBrainIndex(pool: Pool, embedder: BrainEmbedder | null): BrainIndex {
  const embed = async (texts: string[]) => {
    if (!embedder || !texts.length) return null;
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64)
        out.push(...(await embedder.embed(texts.slice(i, i + 64))).vectors);
      return out;
    } catch {
      return null;
    }
  };
  const index: BrainIndex = {
    async upsert(userId, note) {
      const hash = noteHash(note);
      const same = await withUser(pool, userId, async (c) => {
        const r = await c.query<{ content_hash: string }>(
          `SELECT content_hash FROM brain_notes WHERE path = $1`,
          [note.path],
        );
        return r.rows[0]?.content_hash === hash;
      });
      if (same) return false;
      const chunks = chunkNote(note);
      const texts = chunks.map(
        (ch) => `${note.title}. ${ch.heading ? `${ch.heading}. ` : ''}${ch.content}`,
      );
      const vectors = await embed(texts);
      // Anteprima senza i titoletti markdown (le pagine iniziano con «# Titolo», già mostrato a parte).
      const excerpt = note.body
        .split('\n')
        .filter((l) => !/^#{1,6}\s/.test(l.trim()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      await withUser(pool, userId, async (c) => {
        await c.query(
          `INSERT INTO brain_notes (user_id, path, title, note_type, created, refers_from, refers_to, place, lat, lon, links, private, source, excerpt, content_hash, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
           ON CONFLICT (user_id, path) DO UPDATE SET title = EXCLUDED.title, note_type = EXCLUDED.note_type,
             created = EXCLUDED.created, refers_from = EXCLUDED.refers_from, refers_to = EXCLUDED.refers_to,
             place = EXCLUDED.place, lat = EXCLUDED.lat, lon = EXCLUDED.lon, links = EXCLUDED.links,
             private = EXCLUDED.private, source = EXCLUDED.source, excerpt = EXCLUDED.excerpt,
             content_hash = EXCLUDED.content_hash, updated_at = now()`,
          [
            userId,
            note.path,
            note.title,
            note.type,
            Number.isNaN(Date.parse(note.created)) ? new Date() : new Date(note.created),
            note.refersFrom ?? null,
            note.refersTo ?? null,
            note.place ?? null,
            note.coords?.[0] ?? null,
            note.coords?.[1] ?? null,
            [...note.links],
            note.private,
            note.source ?? null,
            excerpt,
            hash,
          ],
        );
        await c.query(`DELETE FROM brain_chunks WHERE path = $1`, [note.path]);
        for (const [i, ch] of chunks.entries()) {
          const v = vectors?.[i];
          await c.query(
            `INSERT INTO brain_chunks (user_id, path, ordinal, heading, content, embedding) VALUES ($1,$2,$3,$4,$5,$6::vector)`,
            [userId, note.path, i, ch.heading, ch.content, v ? vec(v) : null],
          );
        }
      });
      return true;
    },

    async remove(userId, path) {
      await withUser(pool, userId, (c) =>
        c.query(`DELETE FROM brain_notes WHERE path = $1`, [path]),
      );
    },

    async search(userId, q) {
      const limit = Math.min(Math.max(q.limit ?? 6, 1), 20);
      const query = (q.query ?? '').trim();
      if (!query) {
        const rows = await index.list(userId, { ...q, limit });
        return rows.map((r) => ({ ...r, passage: r.excerpt, heading: null, score: 0 }));
      }
      const v = (await embed([query]))?.[0];
      const f = filters(q, 2);
      type R = Row & { heading: string | null; content: string; chunk_id: string };
      const base = `SELECT ${COLS}, k.heading, k.content, k.id AS chunk_id
        FROM brain_chunks k JOIN brain_notes n ON n.user_id = k.user_id AND n.path = k.path`;
      return withUser(pool, userId, async (c) => {
        const fts = await c.query<R>(
          `${base},
             (SELECT CASE WHEN length(to_tsvector('italian', $1)) = 0 THEN NULL
                     ELSE to_tsquery('simple', array_to_string(tsvector_to_array(to_tsvector('italian', $1)), ' | ')) END AS q) x
           WHERE x.q IS NOT NULL AND (k.tsv @@ x.q OR n.title ILIKE '%' || $1 || '%') ${f.sql}
           ORDER BY ts_rank_cd(k.tsv, x.q) DESC LIMIT 30`,
          [query, ...f.params],
        );
        let vecRows: R[] = [];
        if (v) {
          const params = [query, ...f.params, vec(v)];
          vecRows = (
            await c.query<R>(
              `${base} WHERE k.embedding IS NOT NULL AND $1::text IS NOT NULL ${f.sql}
               ORDER BY k.embedding <=> $${params.length}::vector LIMIT 30`,
              params,
            )
          ).rows;
        }
        const score = new Map<string, { row: R; s: number }>();
        const add = (rows: R[]) =>
          rows.forEach((row, i) => {
            const cur = score.get(row.chunk_id) ?? { row, s: 0 };
            cur.s += 1 / (60 + i + 1);
            score.set(row.chunk_id, cur);
          });
        add(fts.rows);
        add(vecRows);
        // Una voce per nota: il pezzo migliore.
        const best = new Map<string, { row: R; s: number }>();
        for (const e of [...score.values()].sort((a, b) => b.s - a.s))
          if (!best.has(e.row.path)) best.set(e.row.path, e);
        return [...best.values()].slice(0, limit).map(({ row, s }) => ({
          ...summary(row),
          passage: row.content.slice(0, 900),
          heading: row.heading,
          score: s,
        }));
      });
    },

    async list(userId, q = {}) {
      const limit = Math.min(Math.max(q.limit ?? 30, 1), 200);
      const f = filters(q, 1);
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLS} FROM brain_notes n WHERE true ${f.sql}
           ORDER BY coalesce(n.refers_from, n.created::date) DESC, n.created DESC LIMIT ${limit}`,
          f.params,
        );
        return r.rows.map(summary);
      });
    },

    async get(userId, path) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(`SELECT ${COLS} FROM brain_notes n WHERE n.path = $1`, [path]);
        return r.rows[0] ? summary(r.rows[0]) : null;
      });
    },

    async findByTitle(userId, title) {
      const t = title.trim().replace(/^\[\[|\]\]$/g, '');
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `SELECT ${COLS} FROM brain_notes n WHERE lower(n.title) = lower($1) OR n.path = $1
           ORDER BY (n.note_type <> 'nota') DESC LIMIT 1`,
          [t],
        );
        return r.rows[0] ? summary(r.rows[0]) : null;
      });
    },

    async count(userId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM brain_notes`);
        return Number(r.rows[0]?.n ?? 0);
      });
    },

    async suggest(userId, text, exclude = []) {
      const t = text.trim();
      if (t.length < 12) return null;
      return withUser(pool, userId, async (c) => {
        type S = {
          path: string;
          title: string;
          note_type: NoteType;
          created: Date;
          refers_from: string | null;
          content: string;
          matched: number;
          total: number;
          title_hit: boolean;
        };
        const r = await c.query<S>(
          `WITH q AS (SELECT tsvector_to_array(to_tsvector('italian', $1)) AS lex)
           SELECT n.path, n.title, n.note_type, n.created, to_char(n.refers_from,'YYYY-MM-DD') AS refers_from,
                  k.content,
                  cardinality(ARRAY(SELECT unnest(q.lex) INTERSECT SELECT unnest(tsvector_to_array(k.tsv)))) AS matched,
                  cardinality(q.lex) AS total,
                  (length(n.title) >= 4 AND lower($1) LIKE '%' || lower(n.title) || '%') AS title_hit
             FROM brain_chunks k JOIN brain_notes n ON n.user_id = k.user_id AND n.path = k.path, q
            WHERE n.private = false AND n.note_type <> 'chi-sono' AND NOT (n.path = ANY($2::text[]))
              AND cardinality(q.lex) >= 2 AND k.tsv @@ to_tsquery('simple', array_to_string(q.lex, ' | '))
            ORDER BY title_hit DESC, matched DESC, n.created DESC LIMIT 5`,
          [t, [...exclude]],
        );
        const best = r.rows.find(
          (row) =>
            row.title_hit || (row.matched >= 2 && row.matched / Math.max(row.total, 1) >= 0.4),
        );
        if (!best) return null;
        return {
          path: best.path,
          title: best.title,
          type: best.note_type,
          when: best.refers_from ?? best.created.toISOString().slice(0, 10),
          passage: best.content.replace(/\s+/g, ' ').slice(0, 400),
          matched: best.matched,
        };
      });
    },

    async paths(userId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ path: string; content_hash: string }>(
          `SELECT path, content_hash FROM brain_notes`,
        );
        return new Map(r.rows.map((x) => [x.path, x.content_hash]));
      });
    },
  };
  return index;
}
