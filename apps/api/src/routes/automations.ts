import { createHash } from 'node:crypto';
import type { ApprovalStore } from '@ernie/agent-core';
import {
  type Automation,
  type AutomationQueue,
  type AutomationRepository,
  AutomationValidationError,
  dedupeKeys,
  EVENT_NAME,
  type EventPublisher,
  enqueueRun,
  jitterMs,
  resolveDeferredApproval,
  TriggerValidationError,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from '@ernie/automations';
import type { Logger } from '@ernie/observability';
import type { ToolCallRecorder, ToolRegistry } from '@ernie/tools';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface AutomationRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly repo: AutomationRepository;
  readonly queue: AutomationQueue;
  readonly events: EventPublisher;
  /** Tool noti al registry: le azioni guidate possono consentire solo questi. */
  readonly knownTools: readonly string[];
  readonly maxRunBudgetUsd: number;
  readonly approvals: {
    readonly store: ApprovalStore;
    readonly registry: ToolRegistry;
    readonly audit: ToolCallRecorder;
  };
  readonly redis: Pick<Redis, 'publish'>;
  readonly logger: Logger;
}

const uuid = z.uuid();
const IdParams = z.object({ id: uuid });
const Limit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const PatchBody = z.object({ enabled: z.boolean() });
const RunNowBody = z.object({ payload: z.unknown().optional() }).default({});
const ReadBody = z.object({ ids: z.array(uuid).min(1).max(200) });
const ApprovalBody = z.object({ decision: z.enum(['approve', 'deny']) });
const EventBody = z.object({
  name: z.string().regex(EVENT_NAME),
  payload: z.unknown().optional(),
  eventId: z.string().min(1).max(128).optional(),
});
const NotificationsQuery = z.object({
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

function badRequest(reply: FastifyReply, code: string, message: string) {
  return reply.code(400).send({ error: code, message });
}

function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: 'not_found', message: `${what} inesistente` });
}

/** Il segreto del webhook esce solo nel blocco `webhook`, con percorso e nome dell'header di firma. */
function present(a: Automation) {
  const { webhookSecret, ...rest } = a;
  return {
    ...rest,
    ...(a.trigger.type === 'webhook' && webhookSecret
      ? {
          webhook: {
            path: `/v1/webhooks/${a.id}`,
            secret: webhookSecret,
            signatureHeader: WEBHOOK_SIGNATURE_HEADER,
            idempotencyHeader: 'x-idempotency-key',
          },
        }
      : {}),
  };
}

const header = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * REST delle automazioni (M6): definizioni, run, notifiche, approvazioni differite, eventi interni,
 * webhook firmati. Stessa autenticazione del WebSocket (chiave API), tranne il webhook (HMAC).
 */
export async function automationRoutes(
  app: FastifyInstance,
  opts: AutomationRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);

  // ---- Webhook: corpo grezzo per la firma HMAC-SHA256, idempotenza da header (o hash del corpo) ----
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser(
      '*',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_req, body, done) => done(null, body),
    );
    hooks.post('/v1/webhooks/:automationId', async (req, reply) => {
      const id = uuid.safeParse((req.params as { automationId: string }).automationId);
      if (!id.success) return notFound(reply, 'Automazione');
      const target = await opts.repo.webhookTarget(id.data);
      if (!target?.secret) return notFound(reply, 'Automazione');
      const raw = typeof req.body === 'string' ? req.body : '';
      if (
        !verifyWebhookSignature(target.secret, raw, header(req.headers[WEBHOOK_SIGNATURE_HEADER]))
      )
        return reply.code(401).send({ error: 'invalid_signature', message: 'Firma non valida' });
      if (!target.enabled)
        return reply.code(409).send({ error: 'disabled', message: 'Automazione disabilitata' });
      let payload: unknown = null;
      if (raw.trim() !== '') {
        try {
          payload = JSON.parse(raw);
        } catch {
          return badRequest(reply, 'invalid_json', 'Il corpo non è JSON valido');
        }
      }
      const idemHeader = header(req.headers['x-idempotency-key']);
      // Senza chiave del chiamante: corpo + finestra di 5 minuti. Solo l'hash del corpo scartava per sempre le
      // chiamate con il corpo uguale (un Comando Rapido con corpo vuoto scattava una volta sola).
      const window = Math.floor(Date.now() / 300_000);
      const idem =
        idemHeader && idemHeader.length <= 128
          ? idemHeader
          : createHash('sha256').update(`${window}:${raw}`).digest('hex').slice(0, 32);
      const automation = await opts.repo.get(target.userId, id.data);
      const res = await enqueueRun(
        opts.queue,
        {
          automationId: id.data,
          userId: target.userId,
          scheduledAt: new Date().toISOString(),
          dedupeKey: dedupeKeys.webhook(idem),
          triggerType: 'webhook',
          payload,
          depth: 0,
        },
        jitterMs(automation?.jitterSeconds ?? 0),
      );
      return reply
        .code(202)
        .send({ accepted: true, duplicate: !res.enqueued, idempotencyKey: idem });
    });
  });

  // ---- Rotte autenticate ----
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/automations', async (req) => ({
      automations: (await opts.repo.list(requireAuth(req).userId)).map(present),
    }));

    api.post('/v1/automations', async (req, reply) => {
      const auth = requireAuth(req);
      try {
        const created = await opts.repo.create(auth.userId, req.body, {
          knownTools: opts.knownTools,
          maxBudgetUsd: opts.maxRunBudgetUsd,
        });
        return reply.code(201).send(present(created));
      } catch (err) {
        if (err instanceof AutomationValidationError || err instanceof TriggerValidationError)
          return badRequest(reply, 'invalid_automation', err.message);
        throw err;
      }
    });

    api.get('/v1/automations/:id', async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return notFound(reply, 'Automazione');
      const a = await opts.repo.get(requireAuth(req).userId, p.data.id);
      return a ? present(a) : notFound(reply, 'Automazione');
    });

    api.patch('/v1/automations/:id', async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      const b = PatchBody.safeParse(req.body);
      if (!p.success) return notFound(reply, 'Automazione');
      if (!b.success) return badRequest(reply, 'invalid_body', 'atteso { enabled: boolean }');
      const a = await opts.repo.setEnabled(requireAuth(req).userId, p.data.id, b.data.enabled);
      return a ? present(a) : notFound(reply, 'Automazione');
    });

    api.delete('/v1/automations/:id', async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return notFound(reply, 'Automazione');
      const ok = await opts.repo.remove(requireAuth(req).userId, p.data.id);
      return ok ? reply.code(204).send() : notFound(reply, 'Automazione');
    });

    api.get('/v1/automations/:id/runs', async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) return notFound(reply, 'Automazione');
      const q = Limit.parse(req.query ?? {});
      return { runs: await opts.repo.listRuns(requireAuth(req).userId, p.data.id, q.limit) };
    });

    /** Esecuzione manuale: una run con chiave `manual:<id>`; il payload (facoltativo) è trattato come non fidato. */
    api.post('/v1/automations/:id/run', async (req, reply) => {
      const auth = requireAuth(req);
      const p = IdParams.safeParse(req.params);
      if (!p.success) return notFound(reply, 'Automazione');
      const b = RunNowBody.safeParse(req.body ?? {});
      if (!b.success) return badRequest(reply, 'invalid_body', 'atteso { payload? }');
      const a = await opts.repo.get(auth.userId, p.data.id);
      if (!a) return notFound(reply, 'Automazione');
      if (!a.enabled)
        return reply.code(409).send({ error: 'disabled', message: 'Automazione disabilitata' });
      const runId = crypto.randomUUID();
      const res = await enqueueRun(opts.queue, {
        automationId: a.id,
        userId: auth.userId,
        scheduledAt: new Date().toISOString(),
        dedupeKey: dedupeKeys.manual(runId),
        triggerType: 'manual',
        ...(b.data.payload === undefined ? {} : { payload: b.data.payload }),
        depth: 0,
      });
      return reply
        .code(202)
        .send({ accepted: true, dedupeKey: dedupeKeys.manual(runId), jobId: res.jobId });
    });

    api.get('/v1/runs', async (req) => {
      const q = Limit.parse(req.query ?? {});
      return { runs: await opts.repo.listRecentRuns(requireAuth(req).userId, q.limit) };
    });

    /** Le azioni sospese nel payload vengono allineate allo stato attuale della run (decisioni già prese). */
    api.get('/v1/notifications', async (req, reply) => {
      const q = NotificationsQuery.safeParse(req.query ?? {});
      if (!q.success) return badRequest(reply, 'invalid_query', 'parametri non validi');
      const userId = requireAuth(req).userId;
      const list = await opts.repo.listNotifications(userId, q.data.unread, q.data.limit);
      const notifications = await Promise.all(
        list.map(async (n) => {
          const payload = n.payload as { runId?: unknown; pendingActions?: unknown } | null;
          if (
            !payload ||
            typeof payload.runId !== 'string' ||
            !Array.isArray(payload.pendingActions)
          )
            return n;
          const run = await opts.repo.getRun(userId, payload.runId);
          if (!run?.outcome?.pendingActions) return n;
          return {
            ...n,
            payload: {
              ...payload,
              pendingActions: run.outcome.pendingActions,
              runStatus: run.status,
            },
          };
        }),
      );
      return { notifications };
    });

    api.post('/v1/notifications/read', async (req, reply) => {
      const b = ReadBody.safeParse(req.body);
      if (!b.success) return badRequest(reply, 'invalid_body', 'atteso { ids: uuid[] }');
      return { marked: await opts.repo.markRead(requireAuth(req).userId, b.data.ids) };
    });

    /** Decisione su un'azione sospesa da una run headless: approvata → eseguita ora con gli stessi argomenti. */
    api.post('/v1/approvals/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const p = IdParams.safeParse(req.params);
      const b = ApprovalBody.safeParse(req.body);
      if (!p.success) return notFound(reply, 'Approvazione');
      if (!b.success)
        return badRequest(reply, 'invalid_body', "atteso { decision: 'approve' | 'deny' }");
      const res = await resolveDeferredApproval(
        {
          repo: opts.repo,
          approvals: opts.approvals.store,
          registry: opts.approvals.registry,
          audit: opts.approvals.audit,
          logger: opts.logger,
          redis: opts.redis,
        },
        auth.userId,
        p.data.id,
        b.data.decision,
      );
      if (res.outcome === 'not_found') return notFound(reply, 'Approvazione (o già decisa)');
      return {
        outcome: res.outcome,
        executed: res.executed,
        ...(res.result === undefined ? {} : { result: res.result }),
        ...(res.run
          ? { run: { id: res.run.id, status: res.run.status, outcome: res.run.outcome } }
          : {}),
      };
    });

    /** Evento interno pubblicato dal client (es. `app.opened`): avvia le automazioni con trigger `event`. */
    api.post('/v1/events', async (req, reply) => {
      const auth = requireAuth(req);
      const b = EventBody.safeParse(req.body);
      if (!b.success)
        return badRequest(reply, 'invalid_body', 'atteso { name, payload?, eventId? }');
      const res = await opts.events.publish(
        auth.userId,
        b.data.name,
        b.data.payload,
        b.data.eventId ? { eventId: b.data.eventId } : {},
      );
      return reply.code(202).send(res);
    });
  });
}
