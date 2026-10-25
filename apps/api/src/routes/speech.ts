import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { SpeechError, type SpeechService } from '../speech.js';
import { createAuthHook } from '../ws/plugin.js';

export interface SpeechRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly speech: SpeechService;
}
const Body = z
  .object({
    text: z.string().trim().min(1).max(2000),
    style: z.enum(['warm', 'playful', 'calm']).default('warm'),
  })
  .strict();

export async function speechRoutes(app: FastifyInstance, opts: SpeechRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    // Come le altre rotte dell'app: serve lo scope «chat» (revisione 25 ott 2026: una chiave ristretta poteva usare la
    // sintesi vocale a pagamento o leggere i consumi).
    api.addHook('preHandler', async (req, reply) => {
      if (!req.auth?.scopes.includes('chat'))
        return reply.code(403).send({ error: 'forbidden', message: 'scope chat richiesto' });
    });
    api.post('/v1/speech', { bodyLimit: 12_000 }, async (req, reply) => {
      const auth = req.auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      const body = Body.safeParse(req.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'Testo o interpretazione non validi' });
      const controller = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      req.raw.on('aborted', cancel);
      reply.raw.on('close', cancel);
      try {
        const audio = await opts.speech.synthesize(
          auth,
          body.data.text,
          body.data.style,
          controller.signal,
        );
        return reply
          .header('content-type', 'audio/mpeg')
          .header('cache-control', 'no-store')
          .send(audio);
      } catch (err) {
        if (err instanceof SpeechError)
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        throw err;
      } finally {
        req.raw.off('aborted', cancel);
        reply.raw.off('close', cancel);
      }
    });
  });
}
