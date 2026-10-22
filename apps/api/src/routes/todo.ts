import { type TodoRepository, TodoSaveInput, TodoValidationError } from '@ernie/tools';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface TodoRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly repo: TodoRepository;
  readonly canUse: (userId: string) => Promise<boolean>;
}
const Id = z.object({ id: z.uuid() });
const Query = z
  .object({
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
const Create = TodoSaveInput.omit({ revision: true }).strict();
const Update = TodoSaveInput.omit({ id: true })
  .extend({ revision: z.number().int().min(1) })
  .strict();
const user = (req: FastifyRequest): string => {
  if (!req.auth) throw Object.assign(new Error('Non autenticato'), { statusCode: 401 });
  return req.auth.userId;
};
export async function todoRoutes(app: FastifyInstance, opts: TodoRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!req.auth)
        return reply.code(401).send({ error: 'unauthorized', message: 'Non autenticato' });
      let enabled = false;
      try {
        enabled = await opts.canUse(req.auth.userId);
      } catch {
        /* Authorization is fail closed. */
      }
      if (!req.auth.scopes.includes('chat') || !enabled)
        return reply.code(403).send({
          error: 'skill_disabled',
          message: 'La funzione Todo non è attiva per questo account.',
        });
    });
    api.setErrorHandler((error, _req, reply) => {
      if (error instanceof TodoValidationError)
        return reply
          .code(error.statusCode)
          .send({ error: error.code, message: error.message, details: error.details });
      return reply.send(error);
    });
    api.get('/v1/todo/lists', async (req, reply) => {
      const query = Query.safeParse(req.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ error: 'invalid_query', message: 'Il filtro giorno non è valido.' });
      return { lists: await opts.repo.list(user(req), query.data) };
    });
    api.post('/v1/todo/lists', async (req, reply) => {
      const body = Create.safeParse(req.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'La lista contiene dati non validi.' });
      return { list: await opts.repo.save(user(req), body.data) };
    });
    api.get('/v1/todo/lists/:id', async (req, reply) => {
      const id = Id.safeParse(req.params);
      if (!id.success)
        return reply.code(400).send({ error: 'invalid_id', message: 'Lista non valida.' });
      const list = await opts.repo.get(user(req), id.data.id);
      if (!list) return reply.code(404).send({ error: 'not_found', message: 'Lista non trovata.' });
      return { list };
    });
    api.put('/v1/todo/lists/:id', async (req, reply) => {
      const id = Id.safeParse(req.params),
        body = Update.safeParse(req.body);
      if (!id.success || !body.success)
        return reply.code(400).send({
          error: 'invalid_body',
          message: 'Rileggi la lista e invia la revisione corrente.',
        });
      if (!(await opts.repo.get(user(req), id.data.id)))
        return reply.code(404).send({ error: 'not_found', message: 'Lista non trovata.' });
      return { list: await opts.repo.save(user(req), { ...body.data, id: id.data.id }) };
    });
  });
}
