import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';
import { OAuthCode, OAuthProof, OAuthState } from './oauth.js';
import { Id, RaindropError, Search, Token } from './provider.js';
import type { RaindropService } from './service.js';

export interface RaindropRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  service: RaindropService;
}
export async function raindropRoutes(app: FastifyInstance, opts: RaindropRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.setErrorHandler((e, _req, reply) => {
      if (e instanceof RaindropError)
        return reply.code(e.statusCode).send({ error: e.code, message: e.message });
      if (e instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: 'invalid_input', message: 'Controlla i dati inseriti.' });
      // Never log request bodies or provider error payloads (they may contain tokens/content).
      return reply.code(503).send({
        error: 'raindrop_unavailable',
        message: 'Il collegamento Raindrop non è disponibile.',
      });
    });
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!req.auth?.scopes.includes('chat')) return reply.code(403).send({ error: 'forbidden' });
    });
    const uid = (req: { auth?: { userId: string } | null }) => {
      if (!req.auth) throw new RaindropError('unauthorized', 'Accedi a Ernie.', 401);
      return req.auth.userId;
    };
    api.get('/v1/raindrop', async (req) => opts.service.status(uid(req)));
    api.post('/v1/raindrop/oauth/start', { bodyLimit: 4096 }, async (req) => {
      const { verifier } = z.object({ verifier: OAuthProof }).strict().parse(req.body);
      return opts.service.beginOAuth(uid(req), verifier);
    });
    api.post('/v1/raindrop/oauth/complete', { bodyLimit: 4096 }, async (req) => {
      const input = z
        .object({ state: OAuthState, verifier: OAuthProof, code: OAuthCode })
        .strict()
        .parse(req.body);
      return opts.service.completeOAuth(uid(req), input);
    });
    api.delete('/v1/raindrop/oauth', async (req) => {
      await opts.service.invalidateAuthorization(uid(req));
      return { ok: true };
    });
    api.put('/v1/raindrop/connection', { bodyLimit: 6000 }, async (req) => {
      const { token } = z.object({ token: Token }).strict().parse(req.body);
      return opts.service.connect(uid(req), token);
    });
    api.delete('/v1/raindrop/connection', async (req) => opts.service.disconnect(uid(req)));
    api.get('/v1/raindrop/collections', async (req) => ({
      items: await opts.service.collections(uid(req)),
    }));
    api.post('/v1/raindrop/search', async (req) =>
      opts.service.search(uid(req), Search.parse(req.body)),
    );
    api.get('/v1/raindrop/bookmarks/:id', async (req) => {
      const p = z.object({ id: z.coerce.number().pipe(Id) }).parse(req.params);
      return opts.service.get(uid(req), p.id);
    });
  });
}
