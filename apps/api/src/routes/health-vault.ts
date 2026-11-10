import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { HealthConsentError } from '../health-protection/consent.js';
import { HealthVaultError, type HealthVaultService } from '../health-protection/service.js';
import { createAuthHook } from '../ws/plugin.js';

export interface HealthVaultRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  service: HealthVaultService;
}
const ConsentBody = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(false) }).strict(),
  z
    .object({
      allowed: z.literal(true),
      expectedRevision: z.number().int().positive(),
      policyVersion: z.number().int().positive(),
    })
    .strict(),
]);
const account = (req: FastifyRequest) => {
  if (!req.auth) throw Object.assign(new Error('Accesso non consentito'), { statusCode: 401 });
  return req.auth;
};
const ids = z.object({ id: z.uuid(), attachmentId: z.uuid().optional() });

/** Owner-account only, no clinical values in URLs, logs, traces or generic chat storage. */
export async function healthVaultRoutes(app: FastifyInstance, opts: HealthVaultRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.setErrorHandler((error: unknown, req, reply) => {
      req.body = undefined;
      if (error instanceof HealthConsentError)
        return reply
          .code(error.code === 'health_consent_changed' ? 409 : 403)
          .send({ error: error.code, message: error.message });
      if (error instanceof HealthVaultError)
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      if (error instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'Richiesta Salute non valida.' });
      const status = (error as { statusCode?: number })?.statusCode;
      const code =
        status === 401
          ? 401
          : status === 403
            ? 403
            : status === 413
              ? 413
              : status && status < 500
                ? 400
                : 503;
      return reply.code(code).send({
        error: code === 503 ? 'health_unavailable' : 'invalid_request',
        message:
          code === 413
            ? 'Allegati troppo grandi. Riduci il numero o la dimensione delle pagine.'
            : 'Operazione Salute non disponibile. Riprova dalla sezione Salute.',
      });
    });
    api.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    });
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      if (!req.auth?.scopes.includes('chat'))
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Accesso a Salute non consentito.' });
    });
    const service = opts.service;
    const silent = { logLevel: 'silent' as const };
    api.get('/v1/health/capabilities', silent, async (req) =>
      service.capabilities(account(req).userId),
    );
    api.post('/v1/health/consent', silent, async (req) => {
      const body = ConsentBody.parse(req.body);
      return body.allowed
        ? service.consent.grant(account(req).userId, body.expectedRevision, body.policyVersion)
        : service.consent.revoke(account(req).userId);
    });
    api.get('/v1/health/sources', silent, async (req) => ({
      sources: await service.sources(account(req).userId),
    }));
    api.post(
      '/v1/health/sources',
      { ...silent, bodyLimit: 32 * 1024 * 1024 },
      async (req, reply) => {
        try {
          return reply
            .code(201)
            .send({ source: await service.upload(account(req).userId, req.body) });
        } finally {
          req.body = undefined;
        }
      },
    );
    api.get('/v1/health/sources/:id', silent, async (req) => ({
      source: await service.source(account(req).userId, ids.parse(req.params).id),
    }));
    api.get('/v1/health/sources/:id/attachments/:attachmentId', silent, async (req) => {
      const params = ids.parse(req.params);
      return {
        attachment: await service.attachment(
          account(req).userId,
          params.id,
          z.uuid().parse(params.attachmentId),
        ),
      };
    });
    api.delete('/v1/health/sources/:id', silent, async (req, reply) => {
      await service.remove(account(req).userId, ids.parse(req.params).id);
      return reply.code(204).send();
    });
    api.get('/v1/health/reports', silent, async (req) => ({
      reports: await service.reports(account(req).userId),
    }));
    api.get('/v1/health/reports/:id', silent, async (req) => ({
      report: await service.report(account(req).userId, ids.parse(req.params).id),
    }));
    // POST avoids placing the user's medical search terms in access logs, browser history or proxies.
    api.post('/v1/health/parameters', silent, async (req) => {
      const body = z
        .object({ name: z.string().min(1).max(100) })
        .strict()
        .parse(req.body);
      try {
        return { parameter: await service.parameter(account(req).userId, body.name) };
      } finally {
        req.body = undefined;
      }
    });
    api.post('/v1/health/export', silent, async (req) => {
      try {
        return await service.export(account(req).userId, req.body);
      } finally {
        req.body = undefined;
      }
    });
    for (const operation of ['analyze', 'ask'] as const) {
      api.post(
        operation === 'ask' ? '/v1/health/ask' : '/v1/health/sources/:id/analyze',
        { ...silent, bodyLimit: 32_000 },
        async (req, reply) => {
          const controller = new AbortController();
          const cancel = () => {
            if (!reply.raw.writableEnded) controller.abort();
          };
          req.raw.on('aborted', cancel);
          reply.raw.on('close', cancel);
          try {
            const result =
              operation === 'ask'
                ? await service.ask(account(req).userId, req.body, controller.signal)
                : await service.analyze(
                    account(req).userId,
                    ids.parse(req.params).id,
                    controller.signal,
                  );
            if (opts.authenticator.refresh) {
              const auth = await opts.authenticator.refresh(account(req));
              if (!auth?.scopes.includes('chat'))
                return reply.code(403).send({ error: 'forbidden', message: 'Accesso revocato.' });
            }
            return result;
          } finally {
            req.body = undefined;
            req.raw.off('aborted', cancel);
            reply.raw.off('close', cancel);
          }
        },
      );
    }
  });
}
