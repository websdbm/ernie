import { type Pool, withUser } from '@ernie/db';
import { SchemaDiagram, SchemaType } from '@ernie/protocol';
import { z } from 'zod';

/** Prodotti da studio di un documento (mai il testo intero: quello resta nella tabella). */
export const Products = z.object({
  abstract: z.string().max(1500),
  keyPoints: z.array(z.string().min(1).max(300)).max(12),
  glossary: z
    .array(z.object({ term: z.string().min(1).max(60), definition: z.string().min(1).max(300) }))
    .max(12)
    .default([]),
  questions: z
    .array(z.object({ question: z.string().min(1).max(300), answer: z.string().min(1).max(400) }))
    .max(10)
    .default([]),
  suggestedSchema: SchemaType,
});
export type Products = z.infer<typeof Products>;

export const DocumentSource = z.enum(['scan', 'photo', 'pdf']);
export type DocumentSource = z.infer<typeof DocumentSource>;

export interface DocumentMeta {
  readonly id: string;
  readonly title: string;
  readonly source: DocumentSource;
  readonly language: string | null;
  readonly pages: number;
  readonly chars: number;
  readonly status: 'ready' | 'summarized';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocumentRecord extends DocumentMeta {
  readonly pageTexts: readonly string[];
  readonly products: Products | null;
  readonly schemas: Partial<Record<SchemaType, SchemaDiagram>>;
}

export interface CreateDocumentInput {
  readonly title?: string;
  readonly source: DocumentSource;
  readonly language?: string;
  readonly pageTexts: readonly string[];
}

export interface DocumentRepository {
  create(userId: string, input: CreateDocumentInput): Promise<DocumentMeta>;
  get(userId: string, id: string): Promise<DocumentRecord | null>;
  describe(userId: string, id: string): Promise<DocumentMeta | null>;
  list(userId: string, query?: string, limit?: number): Promise<DocumentMeta[]>;
  saveProducts(
    userId: string,
    id: string,
    products: Products,
    schema?: { type: SchemaType; diagram: SchemaDiagram },
  ): Promise<void>;
  saveSchema(userId: string, id: string, type: SchemaType, diagram: SchemaDiagram): Promise<void>;
  remove(userId: string, id: string): Promise<boolean>;
}

/** Etichette nude come «Capitolo 1», «Unità 3», «Pag. 12»: non dicono di cosa parla il documento. */
const BARE_LABEL =
  /^(capitolo|cap\.?|unità|unita|lezione|parte|sezione|modulo|pagina|pag\.?)\s*[\dIVXLC]+\.?$/iu;

/** Titolo dal testo: prima riga significativa (≤ 80 caratteri), altrimenti la data. */
export function deriveTitle(pageTexts: readonly string[], now = new Date()): string {
  for (const page of pageTexts) {
    for (const raw of page.split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (line.length >= 4 && /\p{L}/u.test(line) && !BARE_LABEL.test(line)) {
        return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
      }
    }
  }
  return `Documento del ${now.toLocaleDateString('it-IT')}`;
}

interface Row {
  id: string;
  title: string;
  source: DocumentSource;
  language: string | null;
  pages: number;
  chars: number;
  status: 'ready' | 'summarized';
  created_at: Date;
  updated_at: Date;
  page_texts?: string[];
  products?: unknown;
  schemas?: unknown;
}

const META = 'id, title, source, language, pages, chars, status, created_at, updated_at';

const toMeta = (r: Row): DocumentMeta => ({
  id: r.id,
  title: r.title,
  source: r.source,
  language: r.language,
  pages: r.pages,
  chars: r.chars,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const parseSchemas = (raw: unknown): Partial<Record<SchemaType, SchemaDiagram>> => {
  const out: Partial<Record<SchemaType, SchemaDiagram>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = SchemaType.safeParse(k);
    const d = SchemaDiagram.safeParse(v);
    if (t.success && d.success) out[t.data] = d.data;
  }
  return out;
};

export function createDocumentRepository(pool: Pool): DocumentRepository {
  return {
    async create(userId, input) {
      const pageTexts = input.pageTexts.map((t) => t.replace(/\r\n?/g, '\n').trim());
      const body = pageTexts.join('\n\n');
      const title = (input.title ?? '').trim() || deriveTitle(pageTexts);
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `INSERT INTO documents (user_id, title, source, language, pages, chars, page_texts, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING ${META}`,
          [
            userId,
            title.slice(0, 160),
            input.source,
            input.language ?? null,
            pageTexts.length,
            body.length,
            JSON.stringify(pageTexts),
            body,
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error('documento non creato');
        return toMeta(row);
      });
    },
    async get(userId, id) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `SELECT ${META}, page_texts, products, schemas FROM documents WHERE user_id = $1 AND id = $2::uuid AND status <> 'deleted'`,
          [userId, id],
        );
        const r = res.rows[0];
        if (!r) return null;
        const products = Products.safeParse(r.products);
        return {
          ...toMeta(r),
          pageTexts: Array.isArray(r.page_texts) ? r.page_texts : [],
          products: products.success ? products.data : null,
          schemas: parseSchemas(r.schemas),
        };
      });
    },
    async describe(userId, id) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `SELECT ${META} FROM documents WHERE user_id = $1 AND id = $2::uuid AND status <> 'deleted'`,
          [userId, id],
        );
        const r = res.rows[0];
        return r ? toMeta(r) : null;
      });
    },
    async list(userId, query, limit = 20) {
      return withUser(pool, userId, async (client) => {
        const q = query?.trim();
        const res = q
          ? await client.query<Row>(
              `SELECT ${META} FROM documents
               WHERE user_id = $1 AND status <> 'deleted'
                 AND (search @@ plainto_tsquery('italian', $2) OR title ILIKE '%' || $2 || '%')
               ORDER BY ts_rank(search, plainto_tsquery('italian', $2)) DESC, updated_at DESC LIMIT $3`,
              [userId, q, limit],
            )
          : await client.query<Row>(
              `SELECT ${META} FROM documents WHERE user_id = $1 AND status <> 'deleted' ORDER BY updated_at DESC LIMIT $2`,
              [userId, limit],
            );
        return res.rows.map(toMeta);
      });
    },
    async saveProducts(userId, id, products, schema) {
      await withUser(pool, userId, async (client) => {
        await client.query(
          `UPDATE documents
             SET products = $3::jsonb,
                 schemas = CASE WHEN $4::text IS NULL THEN schemas ELSE schemas || jsonb_build_object($4::text, $5::jsonb) END,
                 status = 'summarized', updated_at = now()
           WHERE user_id = $1 AND id = $2::uuid`,
          [
            userId,
            id,
            JSON.stringify(products),
            schema?.type ?? null,
            schema ? JSON.stringify(schema.diagram) : null,
          ],
        );
      });
    },
    async saveSchema(userId, id, type, diagram) {
      await withUser(pool, userId, async (client) => {
        await client.query(
          `UPDATE documents SET schemas = schemas || jsonb_build_object($3::text, $4::jsonb), updated_at = now()
           WHERE user_id = $1 AND id = $2::uuid`,
          [userId, id, type, JSON.stringify(diagram)],
        );
      });
    },
    async remove(userId, id) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE documents SET status = 'deleted', body = '', page_texts = '[]'::jsonb, updated_at = now()
           WHERE user_id = $1 AND id = $2::uuid AND status <> 'deleted'`,
          [userId, id],
        );
        return (res.rowCount ?? 0) > 0;
      });
    },
  };
}
