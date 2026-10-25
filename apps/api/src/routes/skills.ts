import { type Pool, withUser } from '@ernie/db';
import { availableSkillIds, enabledSkillIds, SKILL_CATALOG } from '@ernie/skills';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface SkillsRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly pool: Pool;
  /** Invalida le cache per utente (registry delle skill, agenti di sessione) dopo un cambio. */
  /** `before`: impostazioni effettive (con i limiti del genitore) prima del cambio. */
  readonly onChanged?: (
    userId: string,
    skillId?: string,
    before?: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>;
  /** Controllo genitori: impostazioni effettive con le skill concesse dal genitore (null se non seguito). */
  readonly applyGuardian?: (
    userId: string,
    settings: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

/** `available`: compare nel pannello ✦ (impostazioni); `enabled`: attiva adesso (pannello ✦). */
const PatchBody = z
  .object({ enabled: z.boolean().optional(), available: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.available !== undefined, {
    message: 'atteso { enabled?: boolean, available?: boolean }',
  });

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

/** Sezione Skill dell'app: catalogo con interruttore per utente (`users.settings.skills`). */
export async function skillsRoutes(app: FastifyInstance, opts: SkillsRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);

  const withLimits = async (userId: string, settings: Record<string, unknown>) =>
    opts.applyGuardian ? opts.applyGuardian(userId, settings) : settings;
  const rawSettingsOf = async (userId: string): Promise<Record<string, unknown>> =>
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
  const settingsOf = async (userId: string) => withLimits(userId, await rawSettingsOf(userId));
  const present = (settings: Record<string, unknown>) => {
    const available = availableSkillIds(settings);
    const enabledMap = (settings.skills ?? {}) as Record<string, unknown>;
    const active = enabledSkillIds(settings);
    return SKILL_CATALOG.map((s) => {
      const v = enabledMap[s.id];
      return {
        id: s.id,
        title: s.title,
        icon: s.icon,
        tint: s.tint,
        summary: s.summary,
        description: s.description,
        kind: s.kind,
        tools: s.tools,
        examples: s.examples,
        /** Scelta nelle impostazioni: compare nel pannello ✦ della chat. */
        available: available.has(s.id),
        /** Interruttore del pannello ✦ (conservato anche se la skill non è disponibile). */
        enabled: typeof v === 'boolean' ? v : s.defaultEnabled,
        /** Lavora davvero: disponibile e accesa. */
        active: active.has(s.id),
        /** Controllo genitori: non concessa dal genitore (il figlio non può accenderla). */
        locked: Array.isArray(settings.guardianAllowed) && !settings.guardianAllowed.includes(s.id),
      };
    });
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
        return reply.code(400).send({
          error: 'invalid_body',
          message: 'atteso { enabled?: boolean, available?: boolean }',
        });
      const current = await settingsOf(auth.userId);
      if (Array.isArray(current.guardianAllowed) && !current.guardianAllowed.includes(id))
        return reply.code(403).send({
          error: 'locked',
          message: 'questa skill la sceglie il genitore (controllo genitori)',
        });
      const enabledPatch = b.data.enabled === undefined ? {} : { [id]: b.data.enabled };
      const availablePatch = b.data.available === undefined ? {} : { [id]: b.data.available };
      const settings = await withUser(
        opts.pool,
        auth.userId,
        async (c) =>
          (
            await c.query<{ settings: Record<string, unknown> }>(
              `UPDATE users SET settings = jsonb_set(
                 jsonb_set(settings, '{skills}', COALESCE(settings->'skills', '{}'::jsonb) || $2::jsonb, true),
                 '{skillsAvailable}', COALESCE(settings->'skillsAvailable', '{}'::jsonb) || $3::jsonb, true)
              WHERE id = $1 RETURNING settings`,
              [auth.userId, JSON.stringify(enabledPatch), JSON.stringify(availablePatch)],
            )
          ).rows[0]?.settings ?? {},
      );
      await opts.onChanged?.(auth.userId, id, current);
      return { skills: present(await withLimits(auth.userId, settings)) };
    });
  });
}

const pool = (o: SkillsRoutesOptions): Pool => o.pool;
