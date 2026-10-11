import { createDeviceRepository, DeviceInput } from '@ernie/automations';
import { type Pool, withUser } from '@ernie/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface MeRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly pool: Pool;
  readonly version: string;
}

/** Impostazioni modificabili dall'utente (chiavi in allowlist): il resto di `users.settings` resta intatto. */
const SettingsPatch = z
  .object({
    killSwitch: z.boolean().optional(),
    dailyBudgetUsd: z.number().min(0).max(50).optional(),
    speakReplies: z.boolean().optional(),
  })
  .strict();

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}
const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: 'invalid_body', message });

/** Profilo, impostazioni (interruttore di emergenza) e dispositivi per le notifiche push (M7). */
export async function meRoutes(app: FastifyInstance, opts: MeRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  const devices = createDeviceRepository(opts.pool);

  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/me', async (req) => {
      const auth = requireAuth(req);
      const row = await withUser(
        opts.pool,
        auth.userId,
        async (c) =>
          (
            await c.query<{
              display_name: string;
              locale: string | null;
              settings: Record<string, unknown>;
            }>(`SELECT display_name, locale, settings FROM users WHERE id = $1`, [auth.userId])
          ).rows[0],
      );
      return {
        userId: auth.userId,
        displayName: row?.display_name ?? '',
        locale: row?.locale ?? null,
        companionName: auth.companionName,
        role: auth.role,
        scopes: auth.scopes,
        settings: row?.settings ?? {},
        server: { version: opts.version, protocol: { version: 1, minor: 1 } },
      };
    });

    api.patch('/v1/me/settings', async (req, reply) => {
      const auth = requireAuth(req);
      const b = SettingsPatch.safeParse(req.body);
      if (!b.success)
        return badRequest(reply, 'chiavi ammesse: killSwitch, dailyBudgetUsd, speakReplies');
      const row = await withUser(
        opts.pool,
        auth.userId,
        async (c) =>
          (
            await c.query<{ settings: Record<string, unknown> }>(
              `UPDATE users SET settings = settings || $2::jsonb WHERE id = $1 RETURNING settings`,
              [auth.userId, JSON.stringify(b.data)],
            )
          ).rows[0],
      );
      return { settings: row?.settings ?? {} };
    });

    api.post('/v1/devices', async (req, reply) => {
      const auth = requireAuth(req);
      const b = DeviceInput.safeParse(req.body);
      if (!b.success)
        return badRequest(
          reply,
          'atteso { platform: "ios", token, environment?, appVersion?, locale? }',
        );
      const d = await devices.register(auth.userId, b.data);
      return reply.code(201).send({
        id: d.id,
        platform: d.platform,
        environment: d.environment,
        lastSeenAt: d.lastSeenAt,
      });
    });

    api.get('/v1/devices', async (req) => ({
      devices: (await devices.list(requireAuth(req).userId)).map((d) => ({
        id: d.id,
        platform: d.platform,
        environment: d.environment,
        appVersion: d.appVersion,
        tokenSuffix: d.token.slice(-6),
        lastSeenAt: d.lastSeenAt,
      })),
    }));

    api.delete('/v1/devices/:token', async (req, reply) => {
      const auth = requireAuth(req);
      const token = (req.params as { token: string }).token;
      const ok = await devices.remove(auth.userId, token);
      return ok
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'not_found', message: 'Dispositivo inesistente' });
    });
  });
}
