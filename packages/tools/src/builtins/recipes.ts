import { isDeepStrictEqual } from 'node:util';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import type { ContentBlock } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

export const RECIPE_CATEGORIES = [
  'Antipasti',
  'Primi',
  'Secondi',
  'Contorni',
  'Dolci',
  'Colazioni e merende',
  'Pane e lievitati',
  'Salse e conserve',
  'Bevande',
  'Altro',
] as const;
export const RecipeCategory = z.enum(RECIPE_CATEGORIES);
// Lo schema dei tool deve restare rappresentabile come JSON Schema: normalizzazione nel repository.
export const RecipeTags = z.array(z.string().trim().min(1).max(30)).max(10);
export function normalizeRecipeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().normalize('NFC').toLowerCase()))];
}
export const RecipeOrganization = z.object({
  category: RecipeCategory.nullable(),
  tags: RecipeTags,
  version: z.number().int().min(1),
});
export type RecipeOrganization = z.input<typeof RecipeOrganization>;
export const RecipeBrowseInput = z.object({
  query: z.string().trim().max(200).optional(),
  category: z.union([RecipeCategory, z.literal('non-classificate')]).optional(),
  tag: z.string().trim().min(1).max(30).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export type RecipeBrowseInput = z.input<typeof RecipeBrowseInput>;
export interface RecipeBrowseResult {
  recipes: Recipe[];
  total: number;
  offset: number;
  limit: number;
  categories: { value: string; label: string; count: number }[];
  tags: { name: string; count: number }[];
}
export class RecipeVersionConflictError extends Error {
  override readonly name = 'RecipeVersionConflictError';
  readonly statusCode = 409;
  readonly code = 'version_conflict';
  constructor() {
    super('La ricetta è stata modificata: ricaricala prima di organizzare.');
  }
}

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
  readonly category: string | null;
  readonly version: number;
  readonly updatedAt: Date;
}

export const RecipeInput = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((title) => normalizeTitle(title).length > 0, 'Titolo non valido'),
  ingredients: z.array(z.string().trim().min(1).max(120)).min(1).max(40),
  steps: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  time: z.string().max(40).optional(),
  servings: z.string().max(40).optional(),
  source: z.string().max(120).optional(),
  url: z.url().optional(),
  notes: z.string().max(1000).optional(),
  tags: RecipeTags.optional(),
  category: RecipeCategory.nullable().optional(),
});
export type RecipeInput = z.infer<typeof RecipeInput>;
/** Dati in ingresso prima dei default (`steps` facoltativo; metadati omessi conservati): `save` li valida e normalizza. */
export type RecipeInputData = z.input<typeof RecipeInput>;

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
  category: string | null;
  version: number;
  updated_at: Date;
}
const COLS = `id, title, ingredients, steps, time, servings, source, url, notes, tags, category, version, updated_at`;
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
  category: r.category,
  version: r.version,
  updatedAt: r.updated_at,
});

export interface RecipeRepository {
  /** Crea o aggiorna per titolo normalizzato; solo un cambiamento effettivo crea una versione. Il titolo originale resta. */
  save(
    userId: string,
    input: RecipeInputData,
    reason?: string,
  ): Promise<{ recipe: Recipe; created: boolean }>;
  search(userId: string, query: string | undefined, limit?: number): Promise<Recipe[]>;
  browse(userId: string, input?: RecipeBrowseInput): Promise<RecipeBrowseResult>;
  organize(userId: string, id: string, input: RecipeOrganization): Promise<Recipe | null>;
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
  const snapshot = async (client: PoolClient, userId: string, row: Row, reason: string) => {
    await client.query(
      `INSERT INTO recipe_versions (recipe_id, user_id, version, snapshot, reason) VALUES ($1, $2, $3, $4, $5)`,
      [row.id, userId, row.version, JSON.stringify(toRecipe(row)), reason],
    );
  };
  const browse = async (
    userId: string,
    input: RecipeBrowseInput = {},
  ): Promise<RecipeBrowseResult> => {
    const options = RecipeBrowseInput.parse(input);
    return withUser(pool, userId, async (client) => {
      const params = [
        userId,
        options.query?.trim() || null,
        options.category ?? null,
        options.tag ? normalizeRecipeTags([options.tag])[0] : null,
      ];
      const where = `user_id = $1 AND status = 'active'
        AND ($2::text IS NULL OR search_library @@ plainto_tsquery('italian', recipe_search_normalize($2))
          OR (length(recipe_search_normalize($2)) > 0 AND position(recipe_search_normalize($2) IN recipe_search_normalize(title || ' ' || ingredients::text || ' ' || coalesce(notes, '') || ' ' || coalesce(array_to_string(tags, ' '), '') || ' ' || coalesce(category, ''))) > 0))
        AND ($3::text IS NULL OR ($3 = 'non-classificate' AND category IS NULL) OR category = $3)
        AND ($4::text IS NULL OR $4 IN (SELECT lower(normalize(btrim(t), NFC)) FROM unnest(tags) AS t))`;
      const count = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM recipes WHERE ${where}`,
        params,
      );
      const page = await client.query<Row>(
        `SELECT ${COLS} FROM recipes WHERE ${where} ORDER BY updated_at DESC, id ASC LIMIT $5 OFFSET $6`,
        [...params, options.limit, options.offset],
      );
      const categories = await client.query<{ category: string | null; count: number }>(
        `SELECT category, count(*)::int AS count FROM recipes WHERE user_id = $1 AND status = 'active' GROUP BY category`,
        [userId],
      );
      const tags = await client.query<{ name: string; count: number }>(
        `SELECT lower(normalize(btrim(tag), NFC)) AS name, count(DISTINCT id)::int AS count FROM recipes CROSS JOIN LATERAL unnest(tags) AS tag WHERE user_id = $1 AND status = 'active' AND btrim(tag) <> '' GROUP BY name ORDER BY name`,
        [userId],
      );
      const counts = new Map(categories.rows.map((r) => [r.category, r.count]));
      return {
        recipes: page.rows.map(toRecipe),
        total: count.rows[0]?.total ?? 0,
        offset: options.offset,
        limit: options.limit,
        categories: [
          ...RECIPE_CATEGORIES.map((value) => ({
            value,
            label: value,
            count: counts.get(value) ?? 0,
          })),
          { value: 'non-classificate', label: 'Da organizzare', count: counts.get(null) ?? 0 },
        ],
        tags: tags.rows,
      };
    });
  };
  return {
    browse,
    async save(userId, input, reason = 'salvataggio') {
      const parsed = RecipeInput.parse(input);
      const titleNorm = normalizeTitle(parsed.title);
      return withUser(pool, userId, async (client) => {
        // Lock anche prima del primo INSERT: due acquisizioni simultanee non duplicano titolo o versioni.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `recipe:${userId}:${titleNorm}`,
        ]);
        const existing = await client.query<Row & { status: string }>(
          `SELECT ${COLS}, status FROM recipes WHERE user_id = $1 AND title_norm = $2 FOR UPDATE`,
          [userId, titleNorm],
        );
        const prev = existing.rows[0];
        const params = [
          userId,
          parsed.title,
          titleNorm,
          JSON.stringify(parsed.ingredients),
          JSON.stringify(parsed.steps),
          parsed.time ?? prev?.time ?? null,
          parsed.servings ?? prev?.servings ?? null,
          parsed.source ?? prev?.source ?? null,
          parsed.url ?? prev?.url ?? null,
          parsed.notes ?? prev?.notes ?? null,
          parsed.tags === undefined ? (prev?.tags ?? []) : normalizeRecipeTags(parsed.tags),
          parsed.category === undefined ? (prev?.category ?? null) : parsed.category,
        ];
        let row: Row | undefined;
        if (prev) {
          // Un retry identico non è una modifica: conserva versione, data, storico e coda Brain.
          // Lo stato conta: una ricetta eliminata va comunque ripristinata su richiesta.
          const unchanged =
            prev.status === 'active' &&
            isDeepStrictEqual(prev.ingredients, parsed.ingredients) &&
            isDeepStrictEqual(prev.steps, parsed.steps) &&
            prev.time === params[5] &&
            prev.servings === params[6] &&
            prev.source === params[7] &&
            prev.url === params[8] &&
            prev.notes === params[9] &&
            isDeepStrictEqual([...prev.tags].sort(), [...(params[10] as string[])].sort()) &&
            prev.category === params[11];
          if (unchanged) return { recipe: toRecipe(prev), created: false };
          await snapshot(client, userId, prev, reason);
          const result = await client.query<Row>(
            `UPDATE recipes SET ingredients = $4::jsonb, steps = $5::jsonb, time = $6, servings = $7, source = $8, url = $9,
              notes = $10, tags = $11, category = $12, version = version + 1, status = 'active', updated_at = clock_timestamp()
             WHERE user_id = $1 AND title_norm = $3 AND $2::text IS NOT NULL RETURNING ${COLS}`,
            params,
          );
          row = result.rows[0];
        } else {
          const result = await client.query<Row>(
            `INSERT INTO recipes (user_id, title, title_norm, ingredients, steps, time, servings, source, url, notes, tags, category)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12) RETURNING ${COLS}`,
            params,
          );
          row = result.rows[0];
        }
        if (!row) throw new Error('salvataggio ricetta fallito');
        return { recipe: toRecipe(row), created: !prev };
      });
    },
    async organize(userId, id, input) {
      const validated = RecipeOrganization.parse(input);
      const parsed = { ...validated, tags: normalizeRecipeTags(validated.tags) };
      z.uuid().parse(id);
      return withUser(pool, userId, async (client) => {
        const found = await client.query<Row>(
          `SELECT ${COLS} FROM recipes WHERE user_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
          [userId, id],
        );
        const prev = found.rows[0];
        if (!prev) return null;
        if (prev.version !== parsed.version) throw new RecipeVersionConflictError();
        const sameTags =
          prev.tags.length === parsed.tags.length &&
          prev.tags.every((t) => parsed.tags.includes(t));
        if (prev.category === parsed.category && sameTags) return toRecipe(prev);
        await snapshot(client, userId, prev, 'organizzazione');
        const result = await client.query<Row>(
          `UPDATE recipes SET category = $3, tags = $4, version = version + 1, updated_at = clock_timestamp() WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
          [userId, id, parsed.category, parsed.tags],
        );
        return result.rows[0] ? toRecipe(result.rows[0]) : null;
      });
    },
    async search(userId, query, limit = 6) {
      return (await browse(userId, { ...(query !== undefined ? { query } : {}), limit })).recipes;
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
          recipeId: r.id,
          ...(r.category ? { category: r.category } : {}),
          tags: [...r.tags],
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
  category: z.string().nullable(),
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
  category: r.category,
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
        "Cerca tra le ricette salvate dell'utente per titolo, ingredienti, note, tag o categoria; filtra per categoria e tag. Senza query restituisce le più recenti. Usalo prima di proporre ricette nuove.",
      risk: read,
      inputSchema: z.object({
        query: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(12).optional(),
        category: RecipeBrowseInput.shape.category,
        tag: RecipeBrowseInput.shape.tag,
      }),
      outputSchema: z.object({ recipes: z.array(RecipeOut), count: z.number().int() }),
      execute: async ({ query, limit, category, tag }, ctx) => {
        const recipes =
          category || tag
            ? (
                await repo.browse(ctx.userId, {
                  ...(query ? { query } : {}),
                  ...(category ? { category } : {}),
                  ...(tag ? { tag } : {}),
                  limit: limit ?? 6,
                })
              ).recipes
            : await repo.search(ctx.userId, query, limit ?? 6);
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
      oncePerTurn: true,
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
