import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';
import { HabitsError, type HabitsService } from './service.js';
export interface HabitsRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  service: HabitsService;
}
export async function habitsRoutes(app: FastifyInstance, opts: HabitsRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    api.setErrorHandler((error: unknown, req, reply) => {
      req.body = undefined;
      if (error instanceof HabitsError)
        return reply.code(error.statusCode).send({ error: error.code });
      return reply
        .code(error instanceof z.ZodError ? 400 : 503)
        .send({ error: error instanceof z.ZodError ? 'invalid_request' : 'habits_unavailable' });
    });
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      if (!req.auth?.scopes.includes('chat')) return reply.code(403).send({ error: 'forbidden' });
    });
    const silent = { logLevel: 'silent' as const };
    const user = (r: { auth?: { userId: string } | null }) => {
      if (!r.auth) throw new HabitsError(401, 'unauthorized');
      return r.auth.userId;
    };
    api.get('/v1/habits', silent, (req) => opts.service.get(user(req)));
    api.put('/v1/habits/config', silent, (req) => opts.service.configure(user(req), req.body));
    api.post('/v1/habits/visits', { ...silent, bodyLimit: 128 * 1024 }, (req) =>
      opts.service.upload(user(req), req.body),
    );
    api.patch('/v1/habits/places/:id', silent, (req) =>
      opts.service.updatePlace(
        user(req),
        z.object({ id: z.uuid() }).parse(req.params).id,
        req.body,
      ),
    );
    api.post('/v1/habits/actions', silent, (req) => opts.service.act(user(req), req.body));
    api.post('/v1/habits/question', silent, async (req) => ({
      question: await opts.service.question(
        user(req),
        z.object({ timezone: z.string().max(80) }).parse(req.body).timezone,
      ),
    }));
  });
}
