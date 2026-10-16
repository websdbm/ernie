import { createDeviceRepository, DeviceInput } from '@ernie/automations';
import { type Pool, withUser } from '@ernie/db';
import type { LexiconStore } from '@ernie/memory';
import { ConversationStyle, STYLE_PROFILES, styleOf } from '@ernie/soul';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';
import { lexiconJson } from './guardian.js';

export interface MeRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly pool: Pool;
  readonly version: string;
  /** L'email vive nella scheda anagrafica: cambiata dalle impostazioni, si aggiorna anche lì. */
  readonly onEmailChanged?: (userId: string, email: string) => Promise<void>;
  /** Stile o apprendimento delle parole cambiati: gli agenti dell'utente vanno ricostruiti. */
  readonly onStyleChanged?: (userId: string) => void;
  /** Parole imparate (pagina «Parole che Ernie ha imparato da te»). */
  readonly lexicon?: Pick<LexiconStore, 'list' | 'remove' | 'learningEnabled'>;
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Impostazioni modificabili dall'utente (chiavi in allowlist): il resto di `users.settings` resta intatto. */
const SettingsPatch = z
  .object({
    killSwitch: z.boolean().optional(),
    dailyBudgetUsd: z.number().min(0).max(50).optional(),
    speakReplies: z.boolean().optional(),
    email: z.string().trim().email().max(120).or(z.literal('')).optional(),
    /** Altri indirizzi dell'utente (es. lavoro): da questi si accettano gli inoltri al second brain. */
    extraEmails: z
      .array(z.string().trim().toLowerCase().email().max(120))
      .max(10)
      .transform((list) => [...new Set(list)])
      .optional(),
    emailNotifications: z.boolean().optional(),
    /** Gate della proattività (M9 A3): messaggi spontanei sì/no, ore di quiete, tetto giornaliero. */
    proactive: z.boolean().optional(),
    quietHours: z.object({ start: HHMM, end: HHMM }).strict().nullable().optional(),
    proactiveDailyCap: z.number().int().min(0).max(10).optional(),
    /** Come parla Ernie (16 ott 2026): Neutro, Scherzoso, Essenziale, Antico; vale ovunque. */
    conversationStyle: ConversationStyle.optional(),
    /** Apprendimento delle espressioni dell'utente (acceso se assente). */
    learnLexicon: z.boolean().optional(),
  })
  .strict();

const DiagnosticBody = z
  .object({
    kind: z.enum(['crash', 'hang', 'cpu', 'disk', 'launch', 'other']),
    appVersion: z.string().max(40).optional(),
    osVersion: z.string().max(80).optional(),
    periodStart: z.iso.datetime({ offset: true }).optional(),
    periodEnd: z.iso.datetime({ offset: true }).optional(),
    payload: z.record(z.string(), z.unknown()),
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
        return badRequest(
          reply,
          'chiavi ammesse: killSwitch, dailyBudgetUsd, speakReplies, email, extraEmails, emailNotifications, proactive, quietHours, proactiveDailyCap, conversationStyle, learnLexicon',
        );
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
      if (b.data.email !== undefined) await opts.onEmailChanged?.(auth.userId, b.data.email);
      if (b.data.conversationStyle !== undefined || b.data.learnLexicon !== undefined)
        opts.onStyleChanged?.(auth.userId);
      return { settings: row?.settings ?? {} };
    });

    // «Come parla Ernie»: stili disponibili con l'anteprima, stile scelto, apprendimento e parole imparate.
    api.get('/v1/me/style', async (req) => {
      const auth = requireAuth(req);
      const settings = await withUser(
        opts.pool,
        auth.userId,
        async (c) =>
          (
            await c.query<{ settings: Record<string, unknown> }>(
              `SELECT settings FROM users WHERE id = $1`,
              [auth.userId],
            )
          ).rows[0]?.settings ?? {},
      );
      const own = settings.learnLexicon !== false;
      const enabled = opts.lexicon ? await opts.lexicon.learningEnabled(auth.userId) : own;
      const words = opts.lexicon ? await opts.lexicon.list(auth.userId) : [];
      return {
        styles: STYLE_PROFILES.map(({ id, title, description, example }) => ({
          id,
          title,
          description,
          example,
        })),
        current: styleOf(settings).id,
        learnLexicon: own,
        // Acceso dall'utente ma spento dal genitore (account seguito).
        lexiconLockedByParent: own && !enabled,
        words: words.map(lexiconJson),
      };
    });

    api.delete('/v1/me/lexicon/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success || !opts.lexicon)
        return reply.code(404).send({ error: 'not_found', message: 'parola inesistente' });
      const removed = await opts.lexicon.remove(auth.userId, id);
      if (!removed)
        return reply.code(404).send({ error: 'not_found', message: 'parola inesistente' });
      opts.onStyleChanged?.(auth.userId);
      return reply.code(204).send();
    });

    // Rapporti di iOS (MetricKit): blocchi e chiusure per errore con gli stack, mandati al primo avvio successivo.
    api.post('/v1/diagnostics', { bodyLimit: 2_000_000 }, async (req, reply) => {
      const auth = requireAuth(req);
      const b = DiagnosticBody.safeParse(req.body);
      if (!b.success) return badRequest(reply, 'atteso { kind, payload, appVersion?, osVersion? }');
      const size = JSON.stringify(b.data.payload).length;
      if (size > 1_500_000)
        return reply.code(413).send({ error: 'too_large', message: 'rapporto troppo grande' });
      await withUser(opts.pool, auth.userId, (c) =>
        c.query(
          `INSERT INTO client_diagnostics (user_id, kind, app_version, os_version, period_start, period_end, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            auth.userId,
            b.data.kind,
            b.data.appVersion ?? null,
            b.data.osVersion ?? null,
            b.data.periodStart ?? null,
            b.data.periodEnd ?? null,
            JSON.stringify(b.data.payload),
          ],
        ),
      );
      req.log.info({ userId: auth.userId, kind: b.data.kind, size }, 'rapporto di iOS ricevuto');
      return reply.code(201).send({ ok: true });
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
