import type { ToolRegistry, ToolRuleStore } from '@ernie/tools';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface ToolRulesRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly rules: ToolRuleStore;
  readonly registry: ToolRegistry;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const IdParams = z.object({ id: z.uuid() });
const CreateBody = z.object({ toolId: z.string().min(1).max(80) }).strict();

/** Regole «Consenti sempre» (M9): elenco con descrizione del tool, creazione e revoca (Impostazioni → Conferme). */
export async function toolRulesRoutes(
  app: FastifyInstance,
  opts: ToolRulesRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  const describe = (toolId: string) => {
    const spec = opts.registry.get(toolId);
    return {
      title: spec?.description.split(/[.:]/)[0]?.slice(0, 120) ?? toolId,
      category: spec?.category ?? null,
    };
  };
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/tool-rules', async (req) => ({
      rules: (await opts.rules.list(requireAuth(req).userId)).map((r) => ({
        ...r,
        ...describe(r.toolId),
      })),
    }));

    api.post('/v1/tool-rules', async (req, reply) => {
      const b = CreateBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'atteso { toolId }' });
      const rule = await opts.rules.allow(requireAuth(req).userId, b.data.toolId, 'settings');
      if (!rule)
        return reply.code(422).send({
          error: 'not_eligible',
          message: 'Questo tool chiede sempre conferma (inesistente o con effetto esterno)',
        });
      return reply.code(201).send({ ...rule, ...describe(rule.toolId) });
    });

    api.delete('/v1/tool-rules/:id', async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success)
        return reply.code(404).send({ error: 'not_found', message: 'Regola inesistente' });
      const ok = await opts.rules.remove(requireAuth(req).userId, p.data.id);
      return ok
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'not_found', message: 'Regola inesistente' });
    });
  });
}
