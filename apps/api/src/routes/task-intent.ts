import type { FastifyInstance } from 'fastify';
import type { Authenticator } from '../auth.js';
import {
  askTaskIntent,
  TaskIntentInput,
  type TaskIntentResolver,
  validateTaskIntent,
} from '../task-intent.js';
import { createAuthHook } from '../ws/plugin.js';

export interface TaskIntentRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  resolve: TaskIntentResolver;
}

export async function taskIntentRoutes(app: FastifyInstance, opts: TaskIntentRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  const windows = new Map<string, { at: number; count: number }>();
  const active = new Set<string>();
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.post('/v1/tasks/resolve', { bodyLimit: 20_000 }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const auth = req.auth;
      if (!auth?.scopes.includes('chat') || auth.settings.killSwitch === true)
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Accesso alla chat non disponibile.' });
      const input = TaskIntentInput.safeParse(req.body);
      if (!input.success) return reply.code(400).send({ error: 'invalid_input' });
      const now = Date.now();
      for (const [id, w] of windows) if (now - w.at >= 60_000) windows.delete(id);
      const w = windows.get(auth.userId) ?? { at: now, count: 0 };
      if (active.has(auth.userId) || w.count >= 12 || windows.size >= 10_000)
        return reply.send(askTaskIntent());
      w.count++;
      windows.set(auth.userId, w);
      active.add(auth.userId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3500);
      const onClose = () => {
        if (!reply.raw.writableEnded) ac.abort();
      };
      reply.raw.on('close', onClose);
      try {
        const result = await Promise.race([
          opts.resolve(auth.userId, input.data, ac.signal),
          new Promise<ReturnType<typeof askTaskIntent>>((resolve) => {
            ac.signal.addEventListener('abort', () => resolve(askTaskIntent()), { once: true });
          }),
        ]);
        return reply.send(validateTaskIntent(result, input.data));
      } catch {
        // Provider failures/budget limits must not lose the message or expose its text.
        return reply.send(askTaskIntent());
      } finally {
        clearTimeout(timer);
        reply.raw.off('close', onClose);
        ac.abort();
        active.delete(auth.userId);
      }
    });
  });
}
