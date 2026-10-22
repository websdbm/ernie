import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationValidationError, createAutomationRepository } from './repository.js';
import { dedupeKeys, TriggerValidationError } from './schedule.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('repository delle automazioni (Postgres, ruolo applicativo + RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'A'), ($2, 'B')`, [
      userA,
      userB,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('crea definizioni valide, genera il segreto del webhook, rifiuta trigger notturni, chiavi doppie e tool sconosciuti', async () => {
    const repo = createAutomationRepository(app);
    const cron = await repo.create(userA, {
      key: 'lista_sera',
      title: 'Lista',
      trigger: { type: 'cron', pattern: '0 18 * * *' },
      action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista?' },
    });
    expect(cron.kind).toBe('deterministic');
    expect(cron.webhookSecret).toBeNull();
    const hook = await repo.create(
      userA,
      {
        key: 'ordine',
        title: 'Ordine consegnato',
        trigger: { type: 'webhook' },
        action: {
          type: 'guided',
          instructions: 'Leggi il payload e riassumi.',
          allowedTools: ['get_time'],
        },
      },
      { knownTools: ['get_time'] },
    );
    expect(hook.kind).toBe('guided');
    expect(hook.webhookSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await expect(
      repo.create(userA, {
        key: 'notte',
        title: 'x',
        trigger: { type: 'cron', pattern: '0 2 * * *' },
        action: { type: 'skill', skillId: 's', input: 'x' },
      }),
    ).rejects.toBeInstanceOf(TriggerValidationError);
    await expect(
      repo.create(userA, {
        key: 'lista_sera',
        title: 'Doppia',
        trigger: { type: 'cron', pattern: '0 19 * * *' },
        action: { type: 'skill', skillId: 's', input: 'x' },
      }),
    ).rejects.toThrow(/esiste già/);
    await expect(
      repo.create(
        userA,
        {
          key: 'tool_ignoto',
          title: 'x',
          trigger: { type: 'webhook' },
          action: { type: 'guided', instructions: 'Fai qualcosa.', allowedTools: ['rm_rf'] },
        },
        { knownTools: ['get_time'] },
      ),
    ).rejects.toBeInstanceOf(AutomationValidationError);
    await expect(
      repo.create(
        userA,
        {
          key: 'caro',
          title: 'x',
          trigger: { type: 'webhook' },
          budgetUsd: 3,
          action: { type: 'guided', instructions: 'Fai qualcosa.' },
        },
        { maxBudgetUsd: 0.5 },
      ),
    ).rejects.toThrow(/budget/);

    // RLS: l'altro utente non vede nulla; lo scheduler vede le abilitate di tutti.
    expect(await repo.get(userB, cron.id)).toBeNull();
    expect(await repo.list(userB)).toHaveLength(0);
    const forScheduler = await repo.listEnabledForScheduler();
    expect(forScheduler.map((a) => a.id)).toEqual(expect.arrayContaining([cron.id, hook.id]));

    // Webhook: lookup senza utente tramite funzione SECURITY DEFINER.
    expect(await repo.webhookTarget(hook.id)).toEqual({
      userId: userA,
      secret: hook.webhookSecret,
      enabled: true,
    });
    expect(await repo.webhookTarget(cron.id)).toBeNull();
    expect(await repo.webhookTarget(randomUUID())).toBeNull();

    // Trigger su evento.
    const ev = await repo.create(userA, {
      key: 'spesa_fatta',
      title: 'Dopo la spesa',
      trigger: { type: 'event', eventName: 'shopping_list.cleared' },
      action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista?' },
    });
    expect((await repo.listByEvent(userA, 'shopping_list.cleared')).map((a) => a.id)).toEqual([
      ev.id,
    ]);
    expect(await repo.listByEvent(userB, 'shopping_list.cleared')).toHaveLength(0);
  });

  it('pausa automatica: contatore, pausa con motivo, ripresa che azzera; RLS tra utenti', async () => {
    const repo = createAutomationRepository(app);
    const a = await repo.create(userA, {
      key: 'pausa_test',
      title: 'Pausa',
      trigger: { type: 'cron', pattern: '0 9 * * *' },
      action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista?' },
    });
    expect(a).toMatchObject({ consecutiveFailures: 0, pausedReason: null, pausedAt: null });
    expect(await repo.recordRunOutcome(userA, a.id, true)).toBe(1);
    expect(await repo.recordRunOutcome(userA, a.id, true)).toBe(2);
    expect(await repo.recordRunOutcome(userA, a.id, false)).toBe(0);
    expect(await repo.recordRunOutcome(userA, a.id, true)).toBe(1);
    // Un altro utente non vede né tocca il contatore (RLS).
    expect(await repo.recordRunOutcome(userB, a.id, true)).toBe(0);
    expect(await repo.pause(userB, a.id, 'no')).toBeNull();
    const paused = await repo.pause(userA, a.id, '3 esecuzioni fallite di fila');
    expect(paused).toMatchObject({ enabled: false, pausedReason: '3 esecuzioni fallite di fila' });
    expect(paused?.pausedAt).toBeInstanceOf(Date);
    expect((await repo.listEnabledForScheduler()).some((x) => x.id === a.id)).toBe(false);
    const resumed = await repo.setEnabled(userA, a.id, true);
    expect(resumed).toMatchObject({
      enabled: true,
      consecutiveFailures: 0,
      pausedReason: null,
      pausedAt: null,
    });
  });

  it('reclamo idempotente: due scheduler concorrenti → una run; il retry riprende la stessa riga', async () => {
    const repo = createAutomationRepository(app);
    const a = await repo.create(userA, {
      key: 'idem',
      title: 'Idempotenza',
      trigger: { type: 'cron', pattern: '0 10 * * 6' },
      action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista?' },
    });
    const scheduledAt = new Date('2026-10-17T08:00:00Z');
    const claim = (attempt: number) =>
      repo.claimRun({
        userId: userA,
        automationId: a.id,
        scheduledAt,
        dedupeKey: dedupeKeys.cron(scheduledAt),
        triggerType: 'cron',
        attempt,
      });
    const [r1, r2] = await Promise.all([claim(1), claim(1)]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    const run = (r1 ?? r2) as NonNullable<typeof r1>;
    expect(run.status).toBe('running');
    expect(await claim(1)).toBeNull();

    // Primo tentativo fallito → il secondo tentativo riprende la riga; un terzo con lo stesso numero è un duplicato.
    await repo.finishRun(userA, run.id, { status: 'failed', error: 'ECONNRESET' });
    const retry = await claim(2);
    expect(retry?.id).toBe(run.id);
    expect(retry?.attempt).toBe(2);
    expect(await claim(2)).toBeNull();

    // Esito strutturato, costi, storico.
    const done = await repo.finishRun(userA, run.id, {
      status: 'succeeded',
      outcome: { summary: 'Nella lista: latte', data: { actions: ['list'] } },
      costUsd: 0.0123,
      llmCalls: 0,
      toolCalls: 1,
    });
    expect(done?.status).toBe('succeeded');
    expect(done?.costUsd).toBeCloseTo(0.0123, 6);
    expect(await claim(3)).toBeNull(); // conclusa: nessun retry possibile
    expect((await repo.listRuns(userA, a.id)).map((r) => r.id)).toEqual([run.id]);
    expect((await repo.listRecentRuns(userA, 5)).some((r) => r.id === run.id)).toBe(true);
    expect(await repo.spentTodayUsd(userA, a.id)).toBeCloseTo(0.0123, 6);
    expect(await repo.getRun(userB, run.id)).toBeNull();
  });

  it('decisioni concorrenti su due approvazioni non si sovrascrivono', async () => {
    const repo = createAutomationRepository(app);
    const a = await repo.create(userA, {
      key: 'parallel_approvals',
      title: 'Parallele',
      trigger: { type: 'webhook' },
      action: { type: 'guided', instructions: 'Aggiungi quanto indicato.' },
    });
    const run = await repo.claimRun({
      userId: userA,
      automationId: a.id,
      scheduledAt: new Date(),
      dedupeKey: 'approval-test',
      triggerType: 'webhook',
      attempt: 1,
    });
    if (!run) throw new Error('run non creata');
    const pendingActions = [1, 2].map(() => ({
      approvalId: randomUUID(),
      toolId: 'shopping_list_add',
      args: {},
      reason: 'test',
      expiresAt: new Date().toISOString(),
    }));
    await repo.finishRun(userA, run.id, {
      status: 'awaiting_approval',
      outcome: { summary: 'Azioni', pendingActions },
    });
    await Promise.all(
      pendingActions.map((_, i) =>
        repo.updateRunOutcome(userA, run.id, {
          summary: 'Azioni',
          pendingActions: pendingActions.map((p, n) =>
            n === i ? { ...p, decision: 'approved' as const, executed: true } : p,
          ),
        }),
      ),
    );
    const final = await repo.getRun(userA, run.id);
    expect(final?.outcome?.pendingActions?.every((p) => p.decision === 'approved')).toBe(true);
    expect(final?.status).toBe('succeeded');
  });

  it('azioni sospese: la run si ritrova dall’id di approvazione; notifiche lette e non lette', async () => {
    const repo = createAutomationRepository(app);
    const a = await repo.create(userA, {
      key: 'approvazioni',
      title: 'Approvazioni',
      trigger: { type: 'webhook' },
      action: { type: 'guided', instructions: 'Aggiungi alla lista quanto indicato nel payload.' },
    });
    const run = await repo.claimRun({
      userId: userA,
      automationId: a.id,
      scheduledAt: new Date(),
      dedupeKey: dedupeKeys.webhook('k1'),
      triggerType: 'webhook',
      payload: { items: ['uova'] },
      attempt: 1,
    });
    expect(run).not.toBeNull();
    const approvalId = randomUUID();
    const finished = await repo.finishRun(userA, (run as NonNullable<typeof run>).id, {
      status: 'awaiting_approval',
      outcome: {
        summary: 'Propongo di aggiungere le uova',
        pendingActions: [
          {
            approvalId,
            toolId: 'shopping_list_add',
            args: { items: [{ name: 'uova' }] },
            reason: 'run contaminata',
            expiresAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(finished?.status).toBe('awaiting_approval');
    expect(finished?.triggerPayload).toEqual({ items: ['uova'] });
    expect((await repo.findRunByApproval(userA, approvalId))?.id).toBe(finished?.id);
    expect(await repo.findRunByApproval(userB, approvalId)).toBeNull();
    const updated = await repo.updateRunOutcome(
      userA,
      finished?.id as string,
      {
        ...(finished?.outcome as object),
        pendingActions: [
          {
            approvalId,
            toolId: 'shopping_list_add',
            args: {},
            reason: 'r',
            expiresAt: 'x',
            decision: 'approved',
            executed: true,
          },
        ],
      } as never,
      'succeeded',
    );
    expect(updated?.status).toBe('succeeded');

    const n = await repo.notify(userA, {
      kind: 'automation.approval',
      title: 'Serve approvazione',
      body: 'Uova',
      payload: { runId: finished?.id },
    });
    expect((await repo.listNotifications(userA, true)).map((x) => x.id)).toContain(n.id);
    expect(await repo.markRead(userA, [n.id])).toBe(1);
    expect(await repo.markRead(userA, [n.id])).toBe(0);
    expect((await repo.listNotifications(userA, true)).map((x) => x.id)).not.toContain(n.id);
    expect(await repo.listNotifications(userB, false)).toHaveLength(0);
  });
});
