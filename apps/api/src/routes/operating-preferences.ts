import type { OperatingPreferenceStore } from '@ernie/tools';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface OperatingPreferenceRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  preferences: OperatingPreferenceStore;
  onChanged?: (userId: string) => void;
}
function userId(req: FastifyRequest): string {
  if (!req.auth) throw Object.assign(new Error('Non autenticato'), { statusCode: 401 });
  return req.auth.userId;
}
const body = z
  .object({ text: z.string().min(3).max(400), active: z.boolean().default(true) })
  .strict();
export async function operatingPreferenceRoutes(
  app: FastifyInstance,
  opts: OperatingPreferenceRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!req.auth?.scopes.includes('chat'))
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Accesso alle preferenze non consentito.' });
    });
    api.get('/v1/operating-preferences', async (req) => ({
      preferences: await opts.preferences.list(userId(req)),
    }));
    for (const method of ['POST', 'PATCH'] as const) {
      api.route({
        method,
        url: `/v1/operating-preferences${method === 'PATCH' ? '/:id' : ''}`,
        handler: async (req, reply) => {
          const parsed = body.safeParse(req.body);
          if (!parsed.success)
            return reply.code(400).send({
              error: 'invalid_body',
              message: 'Inserisci una preferenza da 3 a 400 caratteri.',
            });
          try {
            const preference = await opts.preferences.save(userId(req), {
              ...parsed.data,
              ...(method === 'PATCH' ? { id: (req.params as { id: string }).id } : {}),
              kind: 'explicit',
              source: 'settings',
              evidence: parsed.data.text,
            });
            opts.onChanged?.(userId(req));
            return { preference };
          } catch (e) {
            const error = e as { code?: string; message?: string };
            if (
              !error.code ||
              ![
                'not_found',
                'invalid_preference',
                'security_preference',
                'preference_limit',
              ].includes(error.code)
            )
              throw e;
            return reply
              .code(error.code === 'not_found' ? 404 : 400)
              .send({ error: error.code, message: error.message });
          }
        },
      });
    }
    api.delete('/v1/operating-preferences/:id', async (req, reply) => {
      const removed = await opts.preferences.remove(userId(req), (req.params as { id: string }).id);
      if (!removed)
        return reply.code(404).send({ error: 'not_found', message: 'Preferenza non trovata.' });
      opts.onChanged?.(userId(req));
      return { removed: true };
    });
  });
}
