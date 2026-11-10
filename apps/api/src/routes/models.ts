import type { ModelCatalog } from '@ernie/model-gateway';
import { enabledSkillIds } from '@ernie/skills';
import type { FastifyInstance } from 'fastify';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface ModelsRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  catalog: { get(refresh?: boolean): Promise<ModelCatalog> };
  loadSettings(userId: string): Promise<Readonly<Record<string, unknown>>>;
}
export async function modelsRoutes(app: FastifyInstance, opts: ModelsRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.get('/v1/models', async (req, reply) => {
      if (!req.auth?.scopes.includes('chat'))
        return reply.code(403).send({ error: 'forbidden', message: 'Scope chat richiesto.' });
      const settings = await opts.loadSettings(req.auth.userId);
      const active =
        settings.killSwitch !== true &&
        (!Array.isArray(settings.guardianAllowed) ||
          settings.guardianAllowed.includes('maximize')) &&
        enabledSkillIds(settings).has('maximize');
      // No provider request, credentials or catalog when the skill is off.
      if (!active) return { active: false, models: [], updatedAt: null, unavailable: [] };
      return {
        active: true,
        ...(await opts.catalog.get((req.query as { refresh?: string }).refresh === '1')),
      };
    });
  });
}
