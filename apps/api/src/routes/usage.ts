import type { FastifyInstance } from 'fastify';
import type { Authenticator } from '../auth.js';
import { type ProviderAccount, UsageQuery, type UsageService } from '../usage.js';
import { createAuthHook } from '../ws/plugin.js';

export interface UsageRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  service: UsageService;
  providerBalance?: () => Promise<ProviderAccount>;
}

export async function usageRoutes(app: FastifyInstance, opts: UsageRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    // Come le altre rotte dell'app: serve lo scope «chat» (revisione 25 ott 2026: una chiave ristretta poteva usare la
    // sintesi vocale a pagamento o leggere i consumi).
    api.addHook('preHandler', async (req, reply) => {
      if (!req.auth?.scopes.includes('chat'))
        return reply.code(403).send({ error: 'forbidden', message: 'scope chat richiesto' });
    });
    for (const administrative of [false, true]) {
      api.get(administrative ? '/v1/usage/admin' : '/v1/usage', async (req, reply) => {
        if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
        const query = UsageQuery.safeParse(req.query);
        if (!query.success)
          return reply.code(400).send({
            error: 'invalid_query',
            message: 'Controlla il periodo, la data e il fuso orario.',
          });
        const report = await opts.service.report(req.auth.userId, query.data, administrative);
        // La verifica del permesso precede anche l'accesso alla cache del saldo.
        if (report.scope === 'all' && opts.providerBalance)
          report.providerAccount = await opts.providerBalance();
        return report;
      });
    }
  });
}
