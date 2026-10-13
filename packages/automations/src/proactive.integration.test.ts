import { randomUUID } from 'node:crypto';
import { createPgApprovalStore } from '@ernie/agent-core';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deliverDueProactive,
  offerProactive,
  type ProactiveDeps,
  produceApprovalReminders,
} from './proactive.js';
import { createAutomationRepository } from './repository.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('gate della proattività (Postgres, RLS, lock d’invio)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  const published: Array<{ userId: string; type: string }> = [];
  const deps = (now: Date): ProactiveDeps => ({
    pool: app,
    repo: createAutomationRepository(app),
    redis: {
      publish: async (_c: string, msg: string) => {
        published.push(JSON.parse(msg));
        return 1;
      },
    } as never,
    logger: createLogger({ level: 'silent', name: 't' }),
    now: () => now,
  });
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

  const notifications = async (userId: string) =>
    (await createAutomationRepository(app).listNotifications(userId)).map((n) => n.kind);

  it('consegna di giorno una volta sola; di notte rimanda e il worker consegna dopo le 07:30', async () => {
    const noon = new Date('2026-10-13T10:00:00Z');
    const c = {
      userId: userA,
      kind: 'family_reminder' as const,
      dedupeKey: `family_reminder:${randomUUID()}`,
      title: 'Papà ti ha messo un promemoria',
      body: 'chiamarmi (oggi alle 17)',
      payload: { block: { type: 'reminders', title: 'x', reminders: [] } },
      evidence: { source: 'family' as const, refs: [] },
    };
    expect(await offerProactive(deps(noon), c)).toBe('send');
    expect(await offerProactive(deps(noon), c)).toBe('duplicate');
    expect(await notifications(userA)).toEqual(['proactive.family_reminder']);
    expect(published.filter((p) => p.userId === userA).map((p) => p.type)).toEqual([
      'inbox.updated',
      'assistant.block',
    ]);

    // Utente B, alle 23:30 di Roma: rimandato; alle 06:00 ancora quiete; alle 08:00 consegnato.
    const night = new Date('2026-10-13T21:30:00Z');
    const d = { ...c, userId: userB, dedupeKey: `family_reminder:${randomUUID()}` };
    expect(await offerProactive(deps(night), d)).toBe('defer');
    expect(await notifications(userB)).toEqual([]);
    expect(await deliverDueProactive(deps(new Date('2026-10-14T04:00:00Z')))).toBe(0);
    expect(
      await deliverDueProactive(deps(new Date('2026-10-14T06:00:00Z'))),
    ).toBeGreaterThanOrEqual(1);
    expect(await notifications(userB)).toEqual(['proactive.family_reminder']);
    // Una seconda passata non consegna di nuovo (riga già sent).
    expect(await deliverDueProactive(deps(new Date('2026-10-14T06:05:00Z')))).toBe(0);
  });

  it('conferma in scadenza: un solo promemoria per approvazione; spento dall’utente → scartato', async () => {
    const approvals = createPgApprovalStore(app);
    const ap = await approvals.create({
      userId: userA,
      sessionId: null,
      requestId: 'r',
      toolCallId: 't',
      toolId: 'shopping_list_add',
      args: { items: [{ name: 'latte' }] },
      reason: 'automazione',
      ttlMs: 10 * 3_600_000,
    });
    // Creata «13 ore fa» (la retrodatiamo come proprietari del database).
    await owner.query(
      `UPDATE tool_approvals SET created_at = now() - interval '13 hours' WHERE id = $1`,
      [ap.id],
    );
    // Fuori dall'intervallo minimo dal messaggio precedente; ore di quiete spente per non dipendere dall'orario.
    const later = Date.now() + 2 * 3_600_000;
    const at = (ms: number) => later + ms;
    await withUser(app, userA, (c) =>
      c.query(
        `UPDATE users SET settings = settings || '{"quietHours":null}'::jsonb WHERE id = $1`,
        [userA],
      ),
    );
    expect(await produceApprovalReminders(deps(new Date(at(0))))).toBe(1);
    expect(await produceApprovalReminders(deps(new Date(at(60_000))))).toBe(0);
    expect(
      (await notifications(userA)).filter((k) => k === 'proactive.approval_expiring'),
    ).toHaveLength(1);
    // Con i messaggi spontanei spenti la proposta viene registrata e scartata.
    await withUser(app, userB, (c) =>
      c.query(
        `UPDATE users SET settings = settings || '{"proactive":false}'::jsonb WHERE id = $1`,
        [userB],
      ),
    );
    expect(
      await offerProactive(deps(new Date('2026-10-13T10:00:00Z')), {
        userId: userB,
        kind: 'approval_expiring',
        dedupeKey: `approval_expiring:${randomUUID()}`,
        title: 't',
        body: 'b',
        evidence: { source: 'user', refs: [] },
      }),
    ).toBe('drop');
  });
});
