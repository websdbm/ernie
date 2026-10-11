import { type Pool, withUser } from '@ernie/db';
import type { ContentBlock } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

/** Ricetta dell'utente (skill «Ricette»): dati suoi, versionati, mai inviati a terzi. */
export interface Recipe {
  readonly id: string;
  readonly title: string;
  readonly ingredients: readonly string[];
  readonly steps: readonly string[];
  readonly time: string | null;
  readonly servings: string | null;
  readonly source: string | null;
  readonly url: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly version: number;
  readonly updatedAt: Date;
}

export const RecipeInput = z.object({
  title: z.string().min(1).max(120),
  ingredients: z.array(z.string().min(1).max(120)).min(1).max(40),
  steps: z.array(z.string().min(1).max(500)).max(20).default([]),
  time: z.string().max(40).optional(),
  servings: z.string().max(40).optional(),
  source: z.string().max(120).optional(),
  url: z.url().optional(),
  notes: z.string().max(1000).optional(),
  tags: z.array(z.string().min(1).max(30)).max(10).default([]),
});
export type RecipeInput = z.infer<typeof RecipeInput>;

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface Row {
  id: string;
  title: string;
  ingredients: string[];
  steps: string[];
  time: string | null;
  servings: string | null;
  source: string | null;
  url: string | null;
  notes: string | null;
  tags: string[];
  version: number;
  updated_at: Date;
}
const COLS = `id, title, ingredients, steps, time, servings, source, url, notes, tags, version, updated_at`;
const toRecipe = (r: Row): Recipe => ({
  id: r.id,
  title: r.title,
  ingredients: r.ingredients,
  steps: r.steps,
  time: r.time,
  servings: r.servings,
  source: r.source,
  url: r.url,
  notes: r.notes,
  tags: r.tags,
  version: r.version,
  updatedAt: r.updated_at,
});

export interface RecipeRepository {
  /** Crea la ricetta o, se il titolo esiste già (a meno di maiuscole e accenti), la aggiorna creando una nuova versione; il titolo originale resta. */
  save(
    userId: string,
    input: RecipeInput,
    reason?: string,
  ): Promise<{ recipe: Recipe; created: boolean }>;
  search(userId: string, query: string | undefined, limit?: number): Promise<Recipe[]>;
  get(userId: string, idOrTitle: string): Promise<Recipe | null>;
  remove(userId: string, idOrTitle: string): Promise<boolean>;
}

export function createRecipeRepository(pool: Pool): RecipeRepository {
  const lookup = async (
    client: { query: Pool['query'] },
    userId: string,
    idOrTitle: string,
  ): Promise<Row | undefined> => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrTitle);
    const res = await client.query<Row>(
      `SELECT ${COLS} FROM recipes WHERE user_id = $1 AND status = 'active' AND (${isUuid ? 'id = $2::uuid' : 'title_norm = $2'}) LIMIT 1`,
      [userId, isUuid ? idOrTitle : normalizeTitle(idOrTitle)],
    );
    return res.rows[0];
  };
  return {
    async save(userId, input, reason = 'salvataggio') {
      const parsed = RecipeInput.parse(input);
      const titleNorm = normalizeTitle(parsed.title);
      return withUser(pool, userId, async (client) => {
        const existing = await client.query<Row>(
          `SELECT ${COLS} FROM recipes WHERE user_id = $1 AND title_norm = $2`,
          [userId, titleNorm],
        );
        const prev = existing.rows[0];
        const params = [
          userId,
          parsed.title,
          titleNorm,
          JSON.stringify(parsed.ingredients),
          JSON.stringify(parsed.steps),
          parsed.time ?? null,
          parsed.servings ?? null,
          parsed.source ?? null,
          parsed.url ?? null,
          parsed.notes ?? null,
          parsed.tags,
        ];
        let row: Row | undefined;
        if (prev) {
          await client.query(
            `INSERT INTO recipe_versions (recipe_id, user_id, version, snapshot, reason) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (recipe_id, version) DO NOTHING`,
            [prev.id, userId, prev.version, JSON.stringify(toRecipe(prev)), reason],
          );
          const upd = await client.query<Row>(
            `UPDATE recipes SET ingredients = $4::jsonb, steps = $5::jsonb, time = $6, servings = $7, source = $8, url = $9,
                    notes = $10, tags = $11, version = version + 1, status = 'active', updated_at = now()
              WHERE user_id = $1 AND title_norm = $3 AND $2::text IS NOT NULL RETURNING ${COLS}`,
            params,
          );
          row = upd.rows[0];
        } else {
          const ins = await client.query<Row>(
            `INSERT INTO recipes (user_id, title, title_norm, ingredients, steps, time, servings, source, url, notes, tags)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11) RETURNING ${COLS}`,
            params,
          );
          row = ins.rows[0];
        }
        if (!row) throw new Error('salvataggio ricetta fallito');
        return { recipe: toRecipe(row), created: !prev };
      });
    },
    async search(userId, query, limit = 6) {
      return withUser(pool, userId, async (client) => {
        const q = query?.trim();
        const res = q
          ? await client.query<Row>(
              `SELECT ${COLS} FROM recipes
                WHERE user_id = $1 AND status = 'active'
                  AND (search @@ to_tsquery('italian', NULLIF(replace(websearch_to_tsquery('italian', $2)::text, '&', '|'), '')) OR title_norm LIKE '%' || $3 || '%')
                ORDER BY updated_at DESC LIMIT $4`,
              [userId, q, normalizeTitle(q), limit],
            )
          : await client.query<Row>(
              `SELECT ${COLS} FROM recipes WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT $2`,
              [userId, limit],
            );
        return res.rows.map(toRecipe);
      });
    },
    async get(userId, idOrTitle) {
      return withUser(pool, userId, async (client) => {
        const row = await lookup(client, userId, idOrTitle);
        return row ? toRecipe(row) : null;
      });
    },
    async remove(userId, idOrTitle) {
      return withUser(pool, userId, async (client) => {
        const row = await lookup(client, userId, idOrTitle);
        if (!row) return false;
        await client.query(
          `UPDATE recipes SET status = 'deleted', updated_at = now() WHERE id = $1`,
          [row.id],
        );
        return true;
      });
    },
  };
}

const toBlock = (recipes: readonly Recipe[]): ContentBlock | null =>
  recipes.length
    ? {
        kind: 'recipes',
        recipes: recipes.slice(0, 6).map((r) => ({
          title: r.title,
          ingredients: [...r.ingredients],
          ...(r.steps.length ? { steps: [...r.steps] } : {}),
          ...(r.time ? { time: r.time } : {}),
          ...(r.servings ? { servings: r.servings } : {}),
          ...(r.source ? { source: r.source } : {}),
          ...(r.url ? { url: r.url } : {}),
        })),
      }
    : null;

const RecipeOut = z.object({
  id: z.string(),
  title: z.string(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
  time: z.string().nullable(),
  servings: z.string().nullable(),
  source: z.string().nullable(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  version: z.number().int(),
});
const outOf = (r: Recipe) => ({
  id: r.id,
  title: r.title,
  ingredients: [...r.ingredients],
  steps: [...r.steps],
  time: r.time,
  servings: r.servings,
  source: r.source,
  url: r.url,
  notes: r.notes,
  tags: [...r.tags],
  version: r.version,
});

/** Tool della skill «Ricette»: dati privati dell'utente, scritture con `write: true`. */
export function createRecipeTools(repo: RecipeRepository): ToolSpec[] {
  const base = { version: '1', category: 'recipes', timeoutMs: 5_000 } as const;
  const read = {
    readsPrivate: true,
    ingestsUntrusted: false,
    externalEffect: false,
    write: false,
  } as const;
  const write = { ...read, write: true } as const;
  return [
    defineTool({
      ...base,
      id: 'recipe_search',
      description:
        "Cerca tra le ricette salvate dall'utente (per parole del titolo o degli ingredienti); senza query restituisce le più recenti. Usalo prima di proporre ricette nuove.",
      risk: read,
      inputSchema: z.object({
        query: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(12).optional(),
      }),
      outputSchema: z.object({ recipes: z.array(RecipeOut), count: z.number().int() }),
      execute: async ({ query, limit }, ctx) => {
        const recipes = await repo.search(ctx.userId, query, limit ?? 6);
        return { recipes: recipes.map(outOf), count: recipes.length };
      },
      present: (_i, out) => toBlock(out.recipes.map((r) => ({ ...r, updatedAt: new Date() }))),
    }),
    defineTool({
      ...base,
      id: 'recipe_get',
      description: 'Legge una ricetta salvata, per id o per titolo esatto.',
      risk: read,
      inputSchema: z.object({ recipe: z.string().min(1).max(120) }),
      outputSchema: z.object({ found: z.boolean(), recipe: RecipeOut.nullable() }),
      execute: async ({ recipe }, ctx) => {
        const r = await repo.get(ctx.userId, recipe);
        return { found: r !== null, recipe: r ? outOf(r) : null };
      },
      present: (_i, out) =>
        out.recipe ? toBlock([{ ...out.recipe, updatedAt: new Date() }]) : null,
    }),
    defineTool({
      ...base,
      id: 'recipe_save',
      description:
        "Salva una ricetta tra quelle dell'utente o la aggiorna se il titolo esiste già (nuova versione). Chiamalo quando l'utente chiede di salvare, modificare o affinare una ricetta.",
      risk: write,
      inputSchema: RecipeInput.extend({ reason: z.string().max(120).optional() }),
      outputSchema: z.object({ created: z.boolean(), recipe: RecipeOut }),
      execute: async ({ reason, ...input }, ctx) => {
        const r = await repo.save(ctx.userId, input, reason);
        return { created: r.created, recipe: outOf(r.recipe) };
      },
      present: (_i, out) => toBlock([{ ...out.recipe, updatedAt: new Date() }]),
    }),
    defineTool({
      ...base,
      id: 'recipe_delete',
      description:
        "Elimina una ricetta salvata dell'utente (per id o titolo). Solo su richiesta esplicita.",
      risk: write,
      inputSchema: z.object({ recipe: z.string().min(1).max(120) }),
      outputSchema: z.object({ deleted: z.boolean() }),
      execute: async ({ recipe }, ctx) => ({ deleted: await repo.remove(ctx.userId, recipe) }),
    }),
  ];
}
