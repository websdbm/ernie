import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@ernie/config';
import { type Logger, newId } from '@ernie/observability';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { type AutomationRoutesOptions, automationRoutes } from './routes/automations.js';
import { type BrainRoutesOptions, brainRoutes } from './routes/brain.js';
import { type DocumentsRoutesOptions, documentsRoutes } from './routes/documents.js';
import { type FamilyRoutesOptions, familyRoutes } from './routes/family.js';
import { type GuardianRoutesOptions, guardianRoutes } from './routes/guardian.js';
import { type HealthCheck, healthRoutes } from './routes/health.js';
import { type MeRoutesOptions, meRoutes } from './routes/me.js';
import { type ProfileRoutesOptions, profileRoutes } from './routes/profile.js';
import { type RemindersRoutesOptions, remindersRoutes } from './routes/reminders.js';
import { type ShoppingRoutesOptions, shoppingRoutes } from './routes/shopping.js';
import { type SkillsRoutesOptions, skillsRoutes } from './routes/skills.js';
import { type ToolRulesRoutesOptions, toolRulesRoutes } from './routes/tool-rules.js';
import { type WidgetRoutesOptions, widgetRoutes } from './routes/widget.js';
import { registerWs, type WsPluginOptions } from './ws/plugin.js';

export interface BuildServerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Controlli di readiness per nome (es. postgres, redis). */
  readonly checks: Readonly<Record<string, HealthCheck>>;
  /** Endpoint WebSocket del protocollo v1 (assente nei test di sola salute). */
  readonly ws?: WsPluginOptions;
  /** REST delle automazioni, notifiche, approvazioni differite, eventi e webhook (M6). */
  readonly automations?: AutomationRoutesOptions;
  /** Profilo, impostazioni e dispositivi push (M7). */
  readonly me?: MeRoutesOptions;
  /** Catalogo delle skill con interruttori per utente. */
  readonly skills?: SkillsRoutesOptions;
  readonly documents?: DocumentsRoutesOptions;
  readonly shopping?: ShoppingRoutesOptions;
  readonly reminders?: RemindersRoutesOptions;
  /** Scheda anagrafica dell'utente (13 ott 2026). */
  readonly profile?: ProfileRoutesOptions;
  /** Second brain (docs/research/12-second-brain.md). */
  readonly brain?: BrainRoutesOptions;
  /** Famiglia (M7e): collegamenti fra installazioni. */
  readonly family?: FamilyRoutesOptions;
  /** Controllo genitori (0030). */
  readonly guardian?: GuardianRoutesOptions;
  readonly toolRules?: ToolRulesRoutesOptions;
  /** Riepilogo per il widget grande (15 ott 2026). */
  readonly widget?: WidgetRoutesOptions;
}

interface HttpErrorLike {
  statusCode?: unknown;
  code?: unknown;
}

function describeError(err: unknown): { statusCode: number; code: string; message: string } {
  const e: HttpErrorLike = typeof err === 'object' && err !== null ? (err as HttpErrorLike) : {};
  const statusCode =
    typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode <= 599
      ? e.statusCode
      : 500;
  const code = typeof e.code === 'string' && e.code !== '' ? e.code : 'request_error';
  const message = err instanceof Error ? err.message : String(err);
  return { statusCode, code, message };
}

/**
 * Costruisce l'istanza Fastify senza avviarla: usata sia dal bootstrap (index.ts)
 * sia dai test tramite `app.inject()`.
 */
export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  // pino.Logger è strutturalmente compatibile con FastifyBaseLogger; l'annotazione
  // esplicita evita di propagare il tipo concreto di pino nei generics di Fastify.
  const loggerInstance: FastifyBaseLogger = opts.logger;

  const app = Fastify({
    loggerInstance,
    requestIdHeader: 'x-request-id',
    genReqId: () => newId(),
    trustProxy: true,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const { statusCode, code, message } = describeError(err);
    if (statusCode >= 500) req.log.error({ err }, 'errore non gestito');
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : code,
      message: statusCode >= 500 ? 'Errore interno' : message,
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Risorsa non trovata', requestId: req.id });
  });

  // Immagine dell'orso per le email dei promemoria (pubblica, nessun dato dell'utente).
  const bearPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'ernie-bear.png');
  app.get('/static/ernie-bear.png', async (_req, reply) => {
    const png = await readFile(bearPath).catch(() => null);
    if (!png) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=86400')
      .send(png);
  });

  await app.register(healthRoutes, {
    service: opts.config.service,
    env: opts.config.env,
    checks: opts.checks,
  });

  if (opts.ws) await registerWs(app, opts.ws);
  if (opts.automations) await app.register(automationRoutes, opts.automations);
  if (opts.me) await app.register(meRoutes, opts.me);
  if (opts.skills) await app.register(skillsRoutes, opts.skills);
  if (opts.documents) await app.register(documentsRoutes, opts.documents);
  if (opts.shopping) await app.register(shoppingRoutes, opts.shopping);
  if (opts.reminders) await app.register(remindersRoutes, opts.reminders);
  if (opts.widget) await app.register(widgetRoutes, opts.widget);
  if (opts.family) await app.register(familyRoutes, opts.family);
  if (opts.guardian) await app.register(guardianRoutes, opts.guardian);
  if (opts.toolRules) await app.register(toolRulesRoutes, opts.toolRules);
  if (opts.profile) await app.register(profileRoutes, opts.profile);
  if (opts.brain) await app.register(brainRoutes, opts.brain);

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
