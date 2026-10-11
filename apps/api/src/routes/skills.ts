import { type Pool, withUser } from '@ernie/db';
import { enabledSkillIds, SKILL_CATALOG } from '@ernie/skills';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface SkillsRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly pool: Pool;
  /** Invalida le cache per utente (registry delle skill, agenti di sessione) dopo un cambio. */
  readonly onChanged?: (userId: string) => void;
}

const PatchBody = z.object({ enabled: z.boolean() });

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

/** Sezione Skill dell'app: catalogo con interruttore per utente (`users.settings.skills`). */
export async function skillsRoutes(app: FastifyInstance, opts: SkillsRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);

  const settingsOf = async (userId: string): Promise<Record<string, unknown>> =>
    withUser(
      pool(opts),
      userId,
      async (c) =>
        (
          await c.query<{ settings: Record<string, unknown> }>(
            `SELECT settings FROM users WHERE id = $1`,
            [userId],
          )
        ).rows[0]?.settings ?? {},
    );
  const present = (settings: Record<string, unknown>) => {
    const enabled = enabledSkillIds(settings);
    return SKILL_CATALOG.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      kind: s.kind,
      tools: s.tools,
      examples: s.examples,
      enabled: enabled.has(s.id),
    }));
  };

  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/skills', async (req) => ({
      skills: present(await settingsOf(requireAuth(req).userId)),
    }));

    api.patch('/v1/skills/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!SKILL_CATALOG.some((s) => s.id === id))
        return reply.code(404).send({ error: 'not_found', message: 'Skill inesistente' });
      const b = PatchBody.safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'atteso { enabled: boolean }' });
      const settings = await withUser(
        opts.pool,
        auth.userId,
        async (c) =>
          (
            await c.query<{ settings: Record<string, unknown> }>(
              `UPDATE users SET settings = jsonb_set(settings, '{skills}', COALESCE(settings->'skills', '{}'::jsonb) || $2::jsonb, true)
              WHERE id = $1 RETURNING settings`,
              [auth.userId, JSON.stringify({ [id]: b.data.enabled })],
            )
          ).rows[0]?.settings ?? {},
      );
      opts.onChanged?.(auth.userId);
      return { skills: present(settings) };
    });
  });
}

const pool = (o: SkillsRoutesOptions): Pool => o.pool;
