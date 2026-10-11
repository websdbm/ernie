import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import type { ContentBlock } from '@ernie/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecipeRepository, createRecipeTools, normalizeTitle } from './recipes.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe('normalizeTitle', () => {
  it('ignora maiuscole, accenti e punteggiatura', () => {
    expect(normalizeTitle('Pasta e fagioli, alla Napoletana!')).toBe(
      'pasta e fagioli alla napoletana',
    );
    expect(normalizeTitle('Crème brûlée')).toBe('creme brulee');
  });
});

describe.skipIf(!ready)('ricette dell’utente (Postgres, RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 2 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'A'), ($2, 'B')`, [
      userA,
      userB,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('salva, versiona per titolo, cerca, legge ed elimina; l’altro utente non vede nulla', async () => {
    const repo = createRecipeRepository(app);
    const first = await repo.save(userA, {
      title: 'Carbonara',
      ingredients: ['spaghetti', 'guanciale', 'pecorino', 'uova', 'pepe'],
      steps: ['Rosola il guanciale'],
      time: '20 min',
    });
    expect(first.created).toBe(true);
    expect(first.recipe.version).toBe(1);
    const second = await repo.save(
      userA,
      {
        title: 'carbonara',
        ingredients: ['spaghetti', 'guanciale', 'pecorino', 'uova'],
        steps: ['Rosola il guanciale', 'Manteca fuori dal fuoco'],
        time: '20 min',
      },
      'meno pepe',
    );
    expect(second.created).toBe(false);
    expect(second.recipe.version).toBe(2);
    expect(second.recipe.id).toBe(first.recipe.id);
    const versions = await owner.query(
      `SELECT version, reason FROM recipe_versions WHERE recipe_id = $1`,
      [first.recipe.id],
    );
    expect(versions.rows).toEqual([{ version: 1, reason: 'meno pepe' }]);

    await repo.save(userA, {
      title: 'Zuppa di legumi',
      ingredients: ['legumi misti', 'carote', 'sedano'],
    });
    expect((await repo.search(userA, 'guanciale')).map((r) => r.title)).toEqual(['Carbonara']);
    expect((await repo.search(userA, undefined)).length).toBe(2);
    expect((await repo.get(userA, 'CARBONARA'))?.steps).toHaveLength(2);
    expect(await repo.get(userB, 'Carbonara')).toBeNull();
    expect(await repo.search(userB, undefined)).toHaveLength(0);
    expect(await repo.remove(userA, 'Zuppa di legumi')).toBe(true);
    expect((await repo.search(userA, undefined)).map((r) => r.title)).toEqual(['Carbonara']);

    // I tool presentano le ricette come blocco a schema chiuso.
    const tools = createRecipeTools(repo);
    const search = tools.find((t) => t.id === 'recipe_search');
    const out = await search?.execute(
      { query: 'carbonara' },
      {
        userId: userA,
        sessionId: null,
        requestId: 'r',
        scopes: [],
        run: { tainted: false } as never,
      },
    );
    const presented = search?.present?.({ query: 'carbonara' }, out);
    const block = (Array.isArray(presented) ? presented[0] : presented) as
      | ContentBlock
      | null
      | undefined;
    expect(block?.kind).toBe('recipes');
    if (block?.kind === 'recipes') expect(block.recipes[0]?.title).toBe('Carbonara');
  });
});
