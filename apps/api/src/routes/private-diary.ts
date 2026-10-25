import type { FastifyInstance } from 'fastify';
import type { Authenticator } from '../auth.js';
import {
  PrivateDiaryError,
  PrivateDiaryRequest,
  type PrivateDiaryService,
} from '../private-diary.js';
import { createAuthHook } from '../ws/plugin.js';

export interface PrivateDiaryRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  service: PrivateDiaryService;
}
export async function privateDiaryRoutes(app: FastifyInstance, opts: PrivateDiaryRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    // Override the parent's logger/error handler even for JSON parsing, auth and schema failures.
    // Mai il corpo nei log. Gli errori del server (database o autenticazione irraggiungibili) restano 503: con un 400
    // l'app direbbe «richiesta non valida» e non riproverebbe.
    api.setErrorHandler((error: { statusCode?: number }, _req, reply) => {
      const status = error.statusCode;
      if (status === undefined || status >= 500)
        return reply
          .code(503)
          .send({ error: 'unavailable', message: 'Diario non disponibile, riprova tra poco.' });
      return reply
        .code(status === 401 ? 401 : 400)
        .send({ error: 'invalid_request', message: 'Richiesta del diario non valida.' });
    });
    api.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.get('/v1/private-diary/capabilities', { logLevel: 'silent' }, async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
      try {
        return await opts.service.capabilities(req.auth);
      } catch (error) {
        if (error instanceof PrivateDiaryError)
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        return reply.code(503).send({
          error: 'unavailable',
          message: 'Diario personale temporaneamente non disponibile.',
        });
      }
    });
    api.post(
      '/v1/private-diary/transform',
      { logLevel: 'silent', bodyLimit: 400_000 },
      async (req, reply) => {
        if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
        const body = PrivateDiaryRequest.safeParse(req.body);
        if (!body.success) {
          req.body = undefined;
          return reply.code(400).send({
            error: 'invalid_body',
            message: 'Consenso o contenuto del diario non valido.',
          });
        }
        const abort = new AbortController();
        const cancel = () => {
          if (!reply.raw.writableEnded) abort.abort();
        };
        req.raw.on('aborted', cancel);
        reply.raw.on('close', cancel);
        try {
          return await opts.service.transform(req.auth, body.data, abort.signal);
        } catch (error) {
          if (error instanceof PrivateDiaryError)
            return reply.code(error.statusCode).send({ error: error.code, message: error.message });
          return reply.code(503).send({
            error: 'processing_failed',
            message: 'Elaborazione del diario non disponibile.',
          });
        } finally {
          req.body = undefined;
          req.raw.off('aborted', cancel);
          reply.raw.off('close', cancel);
        }
      },
    );
  });
}
