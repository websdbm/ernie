import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { ClientPerformanceBatch, type PerformanceStore } from '../performance.js';
import { createAuthHook } from '../ws/plugin.js';

export interface PerformanceRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  store: PerformanceStore;
}
export async function performanceRoutes(app: FastifyInstance, opts: PerformanceRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    // Come le altre rotte dell'app: serve lo scope «chat» (revisione 25 ott 2026: una chiave ristretta poteva usare la
    // sintesi vocale a pagamento o leggere i consumi).
    api.addHook('preHandler', async (req, reply) => {
      if (!req.auth?.scopes.includes('chat'))
        return reply.code(403).send({ error: 'forbidden', message: 'scope chat richiesto' });
    });
    api.post('/v1/performance/observations', { bodyLimit: 24_000 }, async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = ClientPerformanceBatch.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_observations' });
      return reply
        .code(202)
        .send({ accepted: await opts.store.record(req.auth.userId, parsed.data.observations) });
    });
    api.get('/v1/performance', async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = z
        .object({ days: z.coerce.number().int().min(1).max(90).default(7) })
        .strict()
        .safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      return opts.store.report(req.auth.userId, parsed.data.days);
    });
  });
}
