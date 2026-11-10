import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth.js';
import { modelsRoutes } from './models.js';

describe('Maximize catalog access', () => {
  it('isolates active, disabled and guardian-restricted accounts without exposing keys', async () => {
    const catalog = { get: vi.fn(async () => ({ models: [], updatedAt: 'now', unavailable: [] })) };
    const app = Fastify();
    await app.register(modelsRoutes, {
      authenticator: {
        authenticate: async (bearer) =>
          bearer
            ? ({
                userId: bearer,
                scopes: bearer === 'no-scope' ? [] : ['chat'],
              } as unknown as AuthContext)
            : null,
      },
      allowedOrigins: [],
      catalog,
      loadSettings: async (userId) =>
        userId === 'on'
          ? { skills: { maximize: true } }
          : userId === 'child'
            ? { skills: { maximize: true }, guardianAllowed: [] }
            : {},
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/models',
            headers: { authorization: 'Bearer no-scope' },
          })
        ).statusCode,
      ).toBe(403);
      for (const user of ['off', 'child']) {
        const r = await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: `Bearer ${user}` },
        });
        expect(r.json()).toMatchObject({ active: false, models: [] });
      }
      expect(catalog.get).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/models',
            headers: { authorization: 'Bearer on' },
          })
        ).json(),
      ).toMatchObject({ active: true });
      expect(catalog.get).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
