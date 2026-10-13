import { randomUUID } from 'node:crypto';
import type { Automation, AutomationQueue, AutomationRepository } from '@ernie/automations';
import { UnknownPersonError } from '@ernie/skills';
import { describe, expect, it, vi } from 'vitest';
import type { FamilyLink, FamilyRepository } from './family.js';
import { createReminderStore } from './reminders.js';

const PAPA = randomUUID();
const GIORGIO = randomUUID();
const future = new Date(Date.now() + 3_600_000);

function fakeAutomations() {
  const rows: Automation[] = [];
  const notifications: { userId: string; title: string }[] = [];
  const repo = {
    create: vi.fn(async (userId: string, input: unknown) => {
      const i = input as Record<string, unknown>;
      const a = {
        id: randomUUID(),
        userId,
        key: i.key,
        title: i.title,
        kind: 'deterministic',
        trigger: i.trigger,
        timezone: i.timezone,
        action: i.action,
        budgetUsd: 0,
        catchUp: 'latest',
        jitterSeconds: 0,
        notify: true,
        enabled: true,
        version: 1,
        meta: i.meta ?? {},
        webhookSecret: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Automation;
      rows.push(a);
      return a;
    }),
    get: vi.fn(
      async (userId: string, id: string) =>
        rows.find((a) => a.userId === userId && a.id === id) ?? null,
    ),
    list: vi.fn(async (userId: string) => rows.filter((a) => a.userId === userId)),
    remove: vi.fn(async (userId: string, id: string) => {
      const i = rows.findIndex((a) => a.userId === userId && a.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    }),
    notify: vi.fn(async (userId: string, n: { title: string }) => {
      notifications.push({ userId, title: n.title });
      return {
        id: randomUUID(),
        userId,
        kind: 'x',
        title: n.title,
        body: '',
        payload: null,
        readAt: null,
        createdAt: new Date(),
      };
    }),
  };
  return { repo: repo as unknown as AutomationRepository, rows, notifications };
}

function fakeFamily(): FamilyRepository {
  const links: Record<string, FamilyLink[]> = {
    [PAPA]: [
      {
        id: randomUUID(),
        otherUserId: GIORGIO,
        label: 'Giorgio',
        relation: 'figlio',
        createdAt: new Date(),
      },
    ],
    [GIORGIO]: [
      {
        id: randomUUID(),
        otherUserId: PAPA,
        label: 'papà',
        relation: 'genitore',
        createdAt: new Date(),
      },
    ],
  };
  return {
    list: async (u) => links[u] ?? [],
    find: async (u, label) =>
      (links[u] ?? []).find((l) => l.label.toLowerCase() === label.toLowerCase()) ?? null,
    labelFor: async (u, other) =>
      (links[u] ?? []).find((l) => l.otherUserId === other)?.label ?? null,
    createInvite: async () => {
      throw new Error('non usato');
    },
    listInvites: async () => [],
    removeInvite: async () => false,
    accept: async () => null,
    unlink: async () => false,
  };
}

const queue = {
  add: vi.fn(async () => undefined),
  getJob: vi.fn(async () => null),
} as unknown as AutomationQueue;

describe('store dei promemoria con Famiglia', () => {
  it('con il gate della proattività l’avviso a Giorgio passa da lì (non più notifica diretta)', async () => {
    const fa = fakeAutomations();
    const offered: Array<{ userId: string; kind: string; dedupeKey: string; source: string }> = [];
    const store = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
      family: fakeFamily(),
      proactive: async (c) => {
        offered.push({
          userId: c.userId,
          kind: c.kind,
          dedupeKey: c.dedupeKey,
          source: c.evidence.source,
        });
        expect(c.payload?.block).toMatchObject({ kind: 'reminders', title: 'Promemoria da papà' });
        return 'send';
      },
    });
    const r = await store.create(PAPA, {
      text: 'chiamarmi',
      at: future,
      timezone: 'Europe/Rome',
      forLabel: 'Giorgio',
    });
    expect(offered).toEqual([
      {
        userId: GIORGIO,
        kind: 'family_reminder',
        dedupeKey: `family_reminder:${r.id}`,
        source: 'family',
      },
    ]);
    expect(fa.notifications).toEqual([]);
  });

  it('«ricorda a Giorgio»: automazione nell’account di Giorgio, visibile a entrambi con le etichette giuste', async () => {
    const fa = fakeAutomations();
    const pushed: { userId: string; title: string }[] = [];
    const store = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
      family: fakeFamily(),
      notifyRecipient: async (userId, block) => {
        if (block.kind === 'reminders') pushed.push({ userId, title: block.title });
      },
    });
    const r = await store.create(PAPA, {
      text: 'chiamarmi',
      at: future,
      timezone: 'Europe/Rome',
      forLabel: 'giorgio',
    });
    expect(r.for).toBe('Giorgio');
    expect(fa.rows[0]?.userId).toBe(GIORGIO);
    expect(fa.rows[0]?.title).toBe('Promemoria da papà: chiamarmi');
    expect(fa.rows[0]?.action).toMatchObject({ input: '__promemoria__ [da papà] chiamarmi' });
    expect(fa.rows[0]?.meta).toEqual({ from: PAPA, fromLabel: 'papà', toLabel: 'Giorgio' });
    // Avviso immediato a Giorgio: notifica salvata + scheda nelle sessioni connesse.
    expect(fa.notifications).toEqual([
      { userId: GIORGIO, title: 'papà ti ha messo un promemoria' },
    ]);
    expect(pushed).toEqual([{ userId: GIORGIO, title: 'Promemoria da papà' }]);
    // Elenchi: papà lo vede «per Giorgio», Giorgio «da papà».
    expect((await store.list(PAPA)).map((x) => [x.text, x.for, x.from])).toEqual([
      ['chiamarmi', 'Giorgio', undefined],
    ]);
    expect((await store.list(GIORGIO)).map((x) => [x.text, x.for, x.from])).toEqual([
      ['chiamarmi', undefined, 'papà'],
    ]);
    // Papà lo modifica (nuovo id, sempre nell’account di Giorgio) e poi lo annulla.
    const u = await store.update(PAPA, r.id, { text: 'chiamare papà' });
    expect(u?.for).toBe('Giorgio');
    expect(fa.rows).toHaveLength(1);
    expect(fa.rows[0]?.userId).toBe(GIORGIO);
    expect(await store.remove(PAPA, u?.id ?? '')).toBe(true);
    expect(fa.rows).toHaveLength(0);
  });

  it('etichetta sconosciuta → UnknownPersonError; senza Famiglia idem', async () => {
    const fa = fakeAutomations();
    const store = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
      family: fakeFamily(),
    });
    await expect(
      store.create(PAPA, { text: 'x', at: future, timezone: 'Europe/Rome', forLabel: 'Marco' }),
    ).rejects.toBeInstanceOf(UnknownPersonError);
    const bare = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
    });
    await expect(
      bare.create(PAPA, { text: 'x', at: future, timezone: 'Europe/Rome', forLabel: 'Giorgio' }),
    ).rejects.toBeInstanceOf(UnknownPersonError);
    expect(fa.rows).toHaveLength(0);
  });

  it('i promemoria propri restano invariati (nessuna etichetta) e un estraneo non li vede né li tocca', async () => {
    const fa = fakeAutomations();
    const store = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
      family: fakeFamily(),
    });
    const r = await store.create(GIORGIO, { text: 'compiti', at: future, timezone: 'Europe/Rome' });
    expect(r.for).toBeUndefined();
    expect(fa.rows[0]?.meta).toEqual({});
    expect(await store.list(PAPA)).toEqual([]); // non messo da papà: invisibile
    expect(await store.remove(PAPA, r.id)).toBe(false);
    expect(await store.update(PAPA, r.id, { text: 'altro' })).toBeNull();
  });
});
