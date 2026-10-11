import { randomUUID } from 'node:crypto';
import type { ApprovalStore } from '@ernie/agent-core';
import {
  type Automation,
  AutomationInput,
  type AutomationQueue,
  type AutomationRepository,
  type AutomationRun,
  AutomationValidationError,
  createEventPublisher,
  type Notification,
  signWebhook,
  validateTrigger,
} from '@ernie/automations';
import { loadConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import { ToolRegistry } from '@ernie/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth.js';
import { type AppServer, buildServer } from '../server.js';

const USER = randomUUID();
const KEY = 'ernie_test_key_0123456789';
const auth: AuthContext = {
  userId: USER,
  apiKeyId: randomUUID(),
  scopes: [],
  role: 'owner',
  companionName: 'Ernie',
  settings: {},
};

function fakeRepo() {
  const automations: Automation[] = [];
  const notifications: Notification[] = [];
  const repo: AutomationRepository = {
    create: async (userId, input, opts = {}) => {
      const parsed = AutomationInput.safeParse(input);
      if (!parsed.success) throw new AutomationValidationError(parsed.error.message);
      const a = parsed.data;
      validateTrigger(a.trigger, a.timezone);
      if (a.action.type === 'guided' && opts.knownTools) {
        const unknown = a.action.allowedTools.filter((t) => !opts.knownTools?.includes(t));
        if (unknown.length)
          throw new AutomationValidationError(`tool sconosciuti: ${unknown.join(', ')}`);
      }
      const row: Automation = {
        id: randomUUID(),
        userId,
        key: a.key,
        title: a.title,
        kind: a.action.type === 'skill' ? 'deterministic' : 'guided',
        trigger: a.trigger,
        timezone: a.timezone,
        action: a.action,
        budgetUsd: a.budgetUsd,
        catchUp: a.catchUp,
        jitterSeconds: a.jitterSeconds,
        notify: a.notify,
        enabled: a.enabled,
        version: 1,
        webhookSecret: a.trigger.type === 'webhook' ? 'segreto' : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      automations.push(row);
      return row;
    },
    setEnabled: async (u, id, enabled) => {
      const i = automations.findIndex((a) => a.id === id && a.userId === u);
      if (i < 0) return null;
      automations[i] = { ...(automations[i] as Automation), enabled };
      return automations[i] as Automation;
    },
    remove: async (u, id) => {
      const i = automations.findIndex((a) => a.id === id && a.userId === u);
      if (i < 0) return false;
      automations.splice(i, 1);
      return true;
    },
    get: async (u, id) => automations.find((a) => a.id === id && a.userId === u) ?? null,
    list: async (u) => automations.filter((a) => a.userId === u),
    listByEvent: async (u, name) =>
      automations.filter(
        (a) =>
          a.userId === u && a.enabled && a.trigger.type === 'event' && a.trigger.eventName === name,
      ),
    listEnabledForScheduler: async () => automations.filter((a) => a.enabled),
    webhookTarget: async (id) => {
      const a = automations.find((x) => x.id === id && x.trigger.type === 'webhook');
      return a ? { userId: a.userId, secret: a.webhookSecret, enabled: a.enabled } : null;
    },
    claimRun: async () => null,
    finishRun: async () => null,
    updateRunOutcome: async () => null,
    getRun: async () => null,
    listRuns: async () => [] as AutomationRun[],
    listRecentRuns: async () => [],
    findRunByApproval: async () => null,
    spentTodayUsd: async () => 0,
    getUserSettings: async () => ({}),
    notify: async (u, n) => {
      const x: Notification = {
        id: randomUUID(),
        userId: u,
        kind: n.kind,
        title: n.title,
        body: n.body,
        payload: n.payload ?? null,
        readAt: null,
        createdAt: new Date(),
      };
      notifications.push(x);
      return x;
    },
    listNotifications: async (u, unread) =>
      notifications.filter((n) => n.userId === u && (!unread || !n.readAt)),
    markRead: async (_u, ids) => {
      let n = 0;
      for (const x of notifications)
        if (ids.includes(x.id) && !x.readAt) {
          Object.assign(x, { readAt: new Date() });
          n++;
        }
      return n;
    },
  };
  return { repo, automations, notifications };
}

function fakeQueue() {
  const jobs = new Map<string, unknown>();
  const queue = {
    getJob: async (id: string) => jobs.get(id) ?? null,
    add: async (_name: string, data: unknown, opts: { jobId: string }) => {
      jobs.set(opts.jobId, { id: opts.jobId, data });
      return { id: opts.jobId };
    },
  } as unknown as AutomationQueue;
  return { queue, jobs };
}

describe('REST automazioni, webhook, notifiche, eventi', () => {
  let app: AppServer;
  const { repo, notifications } = fakeRepo();
  const { queue, jobs } = fakeQueue();
  const logger = createLogger({ level: 'silent', name: 'test' });
  const headers = { authorization: `Bearer ${KEY}` };

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    app = await buildServer({
      config,
      logger,
      checks: {},
      automations: {
        authenticator: { authenticate: async (b) => (b === KEY ? auth : null) },
        allowedOrigins: [],
        repo,
        queue,
        events: createEventPublisher({ repo, queue, logger }),
        knownTools: ['get_time', 'shopping_list_get'],
        maxRunBudgetUsd: 0.5,
        approvals: {
          store: {
            create: async () => ({ id: '', expiresAt: new Date(), argsHash: '' }),
            resolve: async () => 'not_found',
            consume: async () => false,
          } as ApprovalStore,
          registry: new ToolRegistry(),
          audit: { record: async () => {} },
        },
        redis: { publish: async () => 1 },
        logger,
      },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('richiede la chiave API', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/automations' })).statusCode).toBe(401);
  });

  it('crea, elenca, aggiorna e cancella; rifiuta trigger notturni e tool sconosciuti', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        key: 'lista_sera',
        title: 'Lista',
        trigger: { type: 'cron', pattern: '0 18 * * *' },
        action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista?' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.json().webhookSecret).toBeUndefined();

    const night = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        key: 'notte',
        title: 'x',
        trigger: { type: 'cron', pattern: '0 2 * * *' },
        action: { type: 'skill', skillId: 's', input: 'x' },
      },
    });
    expect(night.statusCode).toBe(400);
    expect(night.json().error).toBe('invalid_automation');

    const badTool = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        key: 'tool',
        title: 'x',
        trigger: { type: 'webhook' },
        action: { type: 'guided', instructions: 'Fai qualcosa di utile.', allowedTools: ['rm_rf'] },
      },
    });
    expect(badTool.statusCode).toBe(400);
    expect(badTool.json().message).toMatch(/rm_rf/);

    expect(
      (await app.inject({ method: 'GET', url: '/v1/automations', headers })).json().automations,
    ).toHaveLength(1);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/automations/${id}`,
      headers,
      payload: { enabled: false },
    });
    expect(patched.json().enabled).toBe(false);
    const runNow = await app.inject({
      method: 'POST',
      url: `/v1/automations/${id}/run`,
      headers,
      payload: {},
    });
    expect(runNow.statusCode).toBe(409);
    await app.inject({
      method: 'PATCH',
      url: `/v1/automations/${id}`,
      headers,
      payload: { enabled: true },
    });
    const runNow2 = await app.inject({
      method: 'POST',
      url: `/v1/automations/${id}/run`,
      headers,
      payload: {},
    });
    expect(runNow2.statusCode).toBe(202);
    expect(runNow2.json().dedupeKey).toMatch(/^manual:/);
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/automations/${id}`, headers })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/automations/${id}`, headers })).statusCode,
    ).toBe(404);
  });

  it('webhook: firma HMAC obbligatoria, idempotenza da header, 404 per id ignoti', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        key: 'ordine',
        title: 'Ordine',
        trigger: { type: 'webhook' },
        action: {
          type: 'guided',
          instructions: 'Riassumi il payload ricevuto.',
          allowedTools: ['get_time'],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { webhook } = created.json() as {
      webhook: { path: string; secret: string; signatureHeader: string };
    };
    expect(webhook.secret).toBe('segreto');
    const body = JSON.stringify({ ordine: 42 });

    const unsigned = await app.inject({
      method: 'POST',
      url: webhook.path,
      payload: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(401);
    const tampered = await app.inject({
      method: 'POST',
      url: webhook.path,
      payload: `${body} `,
      headers: {
        'content-type': 'application/json',
        [webhook.signatureHeader]: signWebhook('segreto', body),
      },
    });
    expect(tampered.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'POST',
      url: webhook.path,
      payload: body,
      headers: {
        'content-type': 'application/json',
        [webhook.signatureHeader]: signWebhook('segreto', body),
        'x-idempotency-key': 'evt-1',
      },
    });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(ok.json()).toMatchObject({ accepted: true, duplicate: false, idempotencyKey: 'evt-1' });
    const dup = await app.inject({
      method: 'POST',
      url: webhook.path,
      payload: body,
      headers: {
        'content-type': 'application/json',
        [webhook.signatureHeader]: signWebhook('segreto', body),
        'x-idempotency-key': 'evt-1',
      },
    });
    expect(dup.json().duplicate).toBe(true);
    const job = [...jobs.values()].find(
      (j) => (j as { data: { dedupeKey: string } }).data.dedupeKey === 'webhook:evt-1',
    ) as { data: { payload: unknown; triggerType: string } };
    expect(job.data.triggerType).toBe('webhook');
    expect(job.data.payload).toEqual({ ordine: 42 });

    const unknown = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${randomUUID()}`,
      payload: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('eventi interni avviano le automazioni con trigger event; notifiche lette e non lette', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        key: 'spesa_fatta',
        title: 'Dopo la spesa',
        trigger: { type: 'event', eventName: 'shopping_list.cleared' },
        action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista?' },
      },
    });
    const ev = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers,
      payload: { name: 'shopping_list.cleared', payload: { items: 3 }, eventId: 'e-1' },
    });
    expect(ev.statusCode, ev.body).toBe(202);
    expect(ev.json()).toMatchObject({ triggered: 1, eventId: 'e-1' });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers,
      payload: { name: 'shopping_list.cleared', eventId: 'e-1' },
    });
    expect(again.json().triggered).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/events',
          headers,
          payload: { name: 'Nome Non Valido' },
        })
      ).statusCode,
    ).toBe(400);

    await repo.notify(USER, { kind: 'automation.result', title: 'Lista', body: 'latte' });
    const list = await app.inject({ method: 'GET', url: '/v1/notifications?unread=true', headers });
    expect(list.json().notifications).toHaveLength(1);
    const read = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers,
      payload: { ids: [notifications[0]?.id] },
    });
    expect(read.json().marked).toBe(1);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/notifications?unread=true', headers })).json()
        .notifications,
    ).toHaveLength(0);
  });
});
