import { createHash } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';

/**
 * Documenti a pezzi con ancora di pagina (ricerca 11, S2; pipeline ispirata a Khoj, solo l'idea).
 * Pezzi di ~220 parole per pagina con il titolo della sezione corrente (che prosegue tra le pagine), hash
 * per non rifare gli embedding, ricerca ibrida full-text + vettori fusa con RRF. Il testo dei documenti è
 * contenuto esterno: chi lo usa (tool) marca la run come contaminata.
 */
export interface DocumentChunk {
  readonly page: number;
  readonly ordinal: number;
  readonly heading: string | null;
  readonly content: string;
}

export interface ChunkEmbedder {
  readonly model: string;
  embed(texts: string[]): Promise<{ vectors: number[][] }>;
}

const MAX_WORDS = 220;

/** Riga che sembra un titolo: corta, senza punto finale, «Capitolo 3», «2.1 La scrittura», MAIUSCOLO. */
export function isHeading(line: string): boolean {
  const l = line.trim();
  if (l.length < 3 || l.length > 80 || /[.;:,]$/.test(l)) return false;
  if (/^(capitolo|cap\.|paragrafo|lezione|unità|unita|modulo|parte|sezione)\s+\S+/iu.test(l))
    return true;
  if (/^\d+(\.\d+)*\.?\s+\p{Lu}/u.test(l)) return true;
  const letters = l.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && letters === letters.toUpperCase()) return true;
  const words = l.split(/\s+/);
  return words.length <= 7 && /^\p{Lu}/u.test(l) && !/\b(è|sono|ha|hanno|era|erano)\b/iu.test(l);
}

export function chunkDocument(pageTexts: readonly string[]): DocumentChunk[] {
  const out: DocumentChunk[] = [];
  let heading: string | null = null;
  let ordinal = 0;
  pageTexts.forEach((pageText, i) => {
    const page = i + 1;
    let buf: string[] = [];
    let words = 0;
    let lastWasHeading = false;
    const flush = () => {
      const content = buf.join(' ').replace(/\s+/g, ' ').trim();
      if (content.length >= 20) out.push({ page, ordinal: ordinal++, heading, content });
      buf = [];
      words = 0;
    };
    for (const raw of pageText.split(/\n+/)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (isHeading(line) && line.split(/\s+/).length <= 10) {
        flush();
        // Titoli consecutivi si uniscono: «Capitolo 2» + «I Sumeri» → «Capitolo 2 · I Sumeri».
        heading = lastWasHeading && heading ? `${heading} · ${line}`.slice(0, 120) : line;
        lastWasHeading = true;
        continue;
      }
      lastWasHeading = false;
      const w = line.split(/\s+/).length;
      if (words + w > MAX_WORDS && words > 0) flush();
      buf.push(line);
      words += w;
    }
    flush();
  });
  return out;
}

export interface ChunkHit {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly page: number;
  readonly heading: string | null;
  readonly content: string;
}

export interface ChunkStore {
  index(userId: string, documentId: string, pageTexts: readonly string[]): Promise<number>;
  hasChunks(userId: string, documentId: string): Promise<boolean>;
  search(
    userId: string,
    q: { query: string; documentId?: string; fromPage?: number; toPage?: number; limit?: number },
  ): Promise<ChunkHit[]>;
  /** Pagine di una sezione («capitolo 3», «Re-sacerdote e ziqqurat») dai titoli riconosciuti. */
  sectionPages(
    userId: string,
    documentId: string,
    section: string,
  ): Promise<{ fromPage: number; toPage: number } | null>;
}

const vec = (v: readonly number[]) =>
  `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(7) : '0')).join(',')}]`;

export function createChunkStore(pool: Pool, embedder: ChunkEmbedder | null): ChunkStore {
  const embed = async (texts: string[]) => {
    if (!embedder || !texts.length) return null;
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64)
        out.push(...(await embedder.embed(texts.slice(i, i + 64))).vectors);
      return out;
    } catch {
      return null; // senza embedding resta la ricerca full-text
    }
  };
  return {
    async index(userId, documentId, pageTexts) {
      const chunks = chunkDocument(pageTexts);
      const texts = chunks.map((c) => `${c.heading ? `${c.heading}. ` : ''}${c.content}`);
      const vectors = await embed(texts);
      await withUser(pool, userId, async (c) => {
        await c.query(`DELETE FROM document_chunks WHERE document_id = $1`, [documentId]);
        for (const [i, ch] of chunks.entries()) {
          const v = vectors?.[i];
          await c.query(
            `INSERT INTO document_chunks (user_id, document_id, page, ordinal, heading, content, content_hash, embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
            [
              userId,
              documentId,
              ch.page,
              ch.ordinal,
              ch.heading,
              ch.content,
              createHash('sha256')
                .update(texts[i] ?? '')
                .digest('hex'),
              v ? vec(v) : null,
            ],
          );
        }
      });
      return chunks.length;
    },
    async hasChunks(userId, documentId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query(`SELECT 1 FROM document_chunks WHERE document_id = $1 LIMIT 1`, [
          documentId,
        ]);
        return (r.rowCount ?? 0) > 0;
      });
    },
    async search(userId, q) {
      const limit = Math.min(Math.max(q.limit ?? 6, 1), 12);
      const v = (await embed([q.query]))?.[0];
      const filters: string[] = [];
      const params: unknown[] = [q.query];
      if (q.documentId) {
        params.push(q.documentId);
        filters.push(`k.document_id = $${params.length}`);
      }
      if (q.fromPage) {
        params.push(q.fromPage);
        filters.push(`k.page >= $${params.length}`);
      }
      if (q.toPage) {
        params.push(q.toPage);
        filters.push(`k.page <= $${params.length}`);
      }
      const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
      return withUser(pool, userId, async (c) => {
        type R = {
          id: string;
          document_id: string;
          title: string;
          page: number;
          heading: string | null;
          content: string;
        };
        // Parole della domanda in OR: in AND una domanda in linguaggio naturale non trova quasi nulla.
        const fts = await c.query<R>(
          `SELECT k.id, k.document_id, d.title, k.page, k.heading, k.content
             FROM document_chunks k JOIN documents d ON d.id = k.document_id,
                  (SELECT CASE WHEN length(to_tsvector('italian', $1)) = 0 THEN NULL
                          ELSE to_tsquery('italian', array_to_string(tsvector_to_array(to_tsvector('italian', $1)), ' | ')) END AS q) x
            WHERE x.q IS NOT NULL AND k.tsv @@ x.q ${where}
            ORDER BY ts_rank_cd(k.tsv, x.q) DESC LIMIT 30`,
          params,
        );
        let vecRows: R[] = [];
        if (v) {
          // $1 (la domanda) qui non serve, ma i filtri sono numerati da $2: va citato con il suo tipo.
          const p2 = [...params, vec(v)];
          vecRows = (
            await c.query<R>(
              `SELECT k.id, k.document_id, d.title, k.page, k.heading, k.content
                 FROM document_chunks k JOIN documents d ON d.id = k.document_id
                WHERE k.embedding IS NOT NULL AND $1::text IS NOT NULL ${where}
                ORDER BY k.embedding <=> $${p2.length}::vector LIMIT 30`,
              p2,
            )
          ).rows;
        }
        // Fusione RRF (k = 60): un pezzo forte in entrambe le liste sale in cima.
        const score = new Map<string, { row: R; s: number }>();
        const add = (rows: R[], w: number) =>
          rows.forEach((row, i) => {
            const cur = score.get(row.id) ?? { row, s: 0 };
            cur.s += w / (60 + i + 1);
            score.set(row.id, cur);
          });
        add(fts.rows, 1);
        add(vecRows, 1);
        return [...score.values()]
          .sort((a, b) => b.s - a.s)
          .slice(0, limit)
          .map(({ row }) => ({
            id: row.id,
            documentId: row.document_id,
            title: row.title,
            page: row.page,
            heading: row.heading,
            content: row.content,
          }));
      });
    },
    async sectionPages(userId, documentId, section) {
      return withUser(pool, userId, async (c) => {
        const s = section.trim();
        const num = /^(?:capitolo|cap\.?|paragrafo|lezione|unità|parte)?\s*(\d+(?:\.\d+)*)$/iu.exec(
          s,
        )?.[1];
        const r = await c.query<{ heading: string; first: number }>(
          `SELECT heading, min(page) AS first FROM document_chunks
            WHERE document_id = $1 AND heading IS NOT NULL GROUP BY heading ORDER BY min(ordinal)`,
          [documentId],
        );
        const heads = r.rows;
        const idx = heads.findIndex((h) =>
          num
            ? new RegExp(`(^|\\s)${num.replace('.', '\\.')}(\\b|\\.)`, 'u').test(h.heading)
            : h.heading.toLowerCase().includes(s.toLowerCase()),
        );
        if (idx < 0) return null;
        const from = heads[idx]?.first ?? 1;
        // Fine: l'inizio della sezione dello stesso livello successiva (approssimato con la successiva diversa).
        const next = heads.slice(idx + 1).find((h) => h.first > from);
        const last = await c.query<{ p: number }>(
          `SELECT max(page) AS p FROM document_chunks WHERE document_id = $1`,
          [documentId],
        );
        return {
          fromPage: from,
          toPage: next ? Math.max(from, next.first - (num ? 1 : 0)) : (last.rows[0]?.p ?? from),
        };
      });
    },
  };
}
