import { randomUUID } from 'node:crypto';
import { loadConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import {
  presentRecipesTool,
  type Recipe,
  type RecipeRepository,
  RecipeVersionConflictError,
} from '@ernie/tools';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

const owner = randomUUID(),
  other = randomUUID();
const recipe: Recipe = {
  id: randomUUID(),
  title: 'Pasta al limone',
  ingredients: ['200 g pasta', '1 limone'],
  steps: ['Cuoci la pasta.'],
  time: '15 min',
  servings: '2',
  source: 'Appunto',
  url: null,
  notes: null,
  tags: ['veloce'],
  category: 'Primi',
  version: 2,
  updatedAt: new Date('2026-10-17T12:00:00Z'),
};
async function setup(enabled = true) {
  const repo = {
    browse: vi.fn().mockResolvedValue({
      recipes: [recipe],
      total: 1,
      offset: 0,
      limit: 30,
      categories: [{ value: 'Primi', label: 'Primi', count: 1 }],
      tags: [{ name: 'veloce', count: 1 }],
    }),
    get: vi.fn(async (user: string, id: string) =>
      user === owner && id === recipe.id ? recipe : null,
    ),
    organize: vi.fn(async (user: string, id: string) =>
      user === owner && id === recipe.id ? recipe : null,
    ),
    remove: vi.fn(async (user: string, id: string) => user === owner && id === recipe.id),
    save: vi.fn(),
    search: vi.fn(),
  };
  const canUse = vi.fn().mockResolvedValue(enabled);
  const app = await buildServer({
    config: loadConfig({
      DATABASE_URL: 'postgres://x:x@localhost/x',
      REDIS_URL: 'redis://localhost',
    }),
    logger: createLogger({ name: 'recipe-test', level: 'silent' }),
    checks: {},
    recipes: {
      repo: repo as unknown as RecipeRepository,
      canUse,
      allowedOrigins: ['https://allowed.example'],
      authenticator: {
        authenticate: async (key) =>
          key === 'owner' || key === 'other'
            ? {
                userId: key === 'owner' ? owner : other,
                apiKeyId: randomUUID(),
                scopes: ['chat'],
                role: 'owner',
                companionName: 'Ernie',
                settings: {},
              }
            : null,
      },
    },
  });
  return { app, repo, canUse };
}
const headers = { authorization: 'Bearer owner' };

describe('raccolta ricette REST', () => {
  it('richiede autenticazione, origine consentita e skill effettivamente attiva', async () => {
    const { app, repo } = await setup(false);
    try {
      expect((await app.inject('/v1/recipes')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: '/v1/recipes',
            headers: { ...headers, origin: 'https://other.example' },
          })
        ).statusCode,
      ).toBe(403);
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
        const r = await app.inject({
          method,
          url: method === 'GET' ? '/v1/recipes' : `/v1/recipes/${recipe.id}`,
          headers,
          ...(method === 'PATCH' ? { payload: { category: 'Primi', tags: [], version: 2 } } : {}),
        });
        expect(r.statusCode).toBe(403);
        expect(r.json().error).toBe('skill_disabled');
      }
      expect(repo.browse).not.toHaveBeenCalled();
      expect(repo.organize).not.toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('inoltra ricerca e filtri combinati con paginazione, restituisce schede e tassonomia senza cache', async () => {
    const { app, repo } = await setup();
    try {
      const r = await app.inject({
        url: '/v1/recipes?q=limone&category=Primi&tag=veloce&offset=30&limit=30',
        headers,
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(repo.browse).toHaveBeenCalledWith(owner, {
        query: 'limone',
        category: 'Primi',
        tag: 'veloce',
        offset: 30,
        limit: 30,
      });
      expect(r.json().recipes[0]).toMatchObject({
        id: recipe.id,
        category: 'Primi',
        updatedAt: '2026-10-17T12:00:00.000Z',
      });
      expect(r.json().tags).toEqual([{ name: 'veloce', count: 1 }]);
      const detail = await app.inject({ url: `/v1/recipes/${recipe.id}`, headers });
      expect(detail.json().recipe.ingredients).toEqual(recipe.ingredients);
    } finally {
      await app.close();
    }
  });
  it('rifiuta query o payload malformati e non permette di modificare contenuti tramite organizzazione', async () => {
    const { app, repo } = await setup();
    try {
      for (const q of [
        'limit=101',
        'offset=-1',
        'category=Inesistente',
        'tag=',
        `q=${'a'.repeat(121)}`,
        `userId=${other}`,
      ])
        expect((await app.inject({ url: `/v1/recipes?${q}`, headers })).statusCode).toBe(400);
      for (const body of [
        { category: null, tags: [] },
        { category: 'Primi', tags: [], version: 0 },
        { category: null, tags: [' '], version: 2 },
        { category: null, tags: [], version: 2, ingredients: ['altro'] },
      ])
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/v1/recipes/${recipe.id}`,
              headers,
              payload: body,
            })
          ).statusCode,
        ).toBe(400);
      expect(repo.organize).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('organizza con versione obbligatoria e segnala conflitti senza ritentare la scrittura', async () => {
    const { app, repo } = await setup();
    try {
      const body = { category: 'Primi', tags: ['veloce'], version: 2 };
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/v1/recipes/${recipe.id}`,
            headers,
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
      expect(repo.organize).toHaveBeenCalledWith(owner, recipe.id, body);
      repo.organize.mockRejectedValueOnce(new RecipeVersionConflictError());
      const conflict = await app.inject({
        method: 'PATCH',
        url: `/v1/recipes/${recipe.id}`,
        headers,
        payload: body,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error).toBe('version_conflict');
      expect(repo.organize).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it('usa sempre il proprietario autenticato e non rivela schede altrui', async () => {
    const { app, repo } = await setup();
    try {
      for (const method of ['GET', 'DELETE', 'PATCH'] as const) {
        const r = await app.inject({
          method,
          url: `/v1/recipes/${recipe.id}`,
          headers: { authorization: 'Bearer other' },
          ...(method === 'PATCH' ? { payload: { category: null, tags: [], version: 2 } } : {}),
        });
        expect(r.statusCode).toBe(404);
      }
      expect(repo.get).toHaveBeenCalledWith(other, recipe.id);
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/recipes/${recipe.id}`, headers }))
          .statusCode,
      ).toBe(204);
      expect((await app.inject({ url: '/v1/recipes/not-a-uuid', headers })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

it('una proposta del modello non puo fingersi una ricetta gia salvata', () => {
  const parsed = presentRecipesTool.inputSchema.parse({
    recipes: [{ recipeId: recipe.id, title: 'Proposta', ingredients: ['1 uovo'] }],
  });
  expect(parsed).toEqual({ recipes: [{ title: 'Proposta', ingredients: ['1 uovo'] }] });
});
