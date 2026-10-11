import type { ReminderStore } from '@ernie/skills';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface RemindersRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly store: ReminderStore;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

/** Promemoria per l'app (scheda e widget): elenco dei prossimi e annullamento. */
export async function remindersRoutes(
  app: FastifyInstance,
  opts: RemindersRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/reminders', async (req) => {
      const auth = requireAuth(req);
      const list = await opts.store.list(auth.userId);
      return {
        reminders: list.map((r) => ({
          id: r.id,
          text: r.text,
          at: r.at.toISOString(),
          status: r.status,
        })),
      };
    });

    api.delete('/v1/reminders/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const ok = await opts.store.remove(auth.userId, id);
      if (!ok)
        return reply.code(404).send({ error: 'not_found', message: 'promemoria inesistente' });
      return reply.code(204).send();
    });
  });
}
