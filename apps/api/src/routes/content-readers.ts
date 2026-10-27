import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import type { ContentReaderDiagnostics } from '../content-readers.js';
import { createAuthHook } from '../ws/plugin.js';

export interface ContentReaderRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  diagnostics: ContentReaderDiagnostics;
}
export async function contentReaderRoutes(app: FastifyInstance, opts: ContentReaderRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!req.auth?.scopes.includes('chat')) return reply.code(403).send({ error: 'forbidden' });
    });
    api.get('/v1/content-readers', async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
      if (!z.object({}).strict().safeParse(req.query).success)
        return reply.code(400).send({ error: 'invalid_query' });
      return opts.diagnostics.report(req.auth.userId);
    });
  });
}
