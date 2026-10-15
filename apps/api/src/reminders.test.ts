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
    mergeMeta: vi.fn(async (userId: string, id: string, patch: Record<string, unknown>) => {
      const i = rows.findIndex((a) => a.userId === userId && a.id === id);
      const cur = rows[i];
      if (i < 0 || !cur) return null;
      const next = { ...cur, meta: { ...cur.meta, ...patch } } as Automation;
      rows[i] = next;
      return next;
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
    preview: async () => null,
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
  it('titolo breve dal punto di vista di chi lo riceve; senza modello, pulizia deterministica', async () => {
    const fa = fakeAutomations();
    const seen: Array<{ text: string; fromLabel?: string }> = [];
    const store = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
      family: fakeFamily(),
      title: async (text, ctx) => {
        seen.push({ text, ...(ctx.fromLabel ? { fromLabel: ctx.fromLabel } : {}) });
        return ctx.fromLabel
          ? `Chiamare ${ctx.fromLabel}`
          : 'Prendere Giorgio e portarlo alla visita';
      },
    });
    const mine = await store.create(PAPA, {
      text: 'uscire per andare a prendere Giorgio e portare la visita',
      at: future,
      timezone: 'Europe/Rome',
    });
    expect(mine.text).toBe('Prendere Giorgio e portarlo alla visita');
    const his = await store.create(PAPA, {
      text: 'chiamarmi',
      at: future,
      timezone: 'Europe/Rome',
      forLabel: 'Giorgio',
    });
    expect(his.text).toBe('Chiamare papà');
    expect(seen).toEqual([
      { text: 'uscire per andare a prendere Giorgio e portare la visita' },
      { text: 'chiamarmi', fromLabel: 'papà' },
    ]);
    const plain = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
    });
    expect(
      (await plain.create(PAPA, { text: 'andare a lavoro', at: future, timezone: 'Europe/Rome' }))
        .text,
    ).toBe('Andare al lavoro');
  });

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
    expect(fa.rows[0]?.title).toBe('Promemoria da papà: Chiamarmi'); // senza modello: pulizia deterministica
    expect(fa.rows[0]?.action).toMatchObject({ input: '__promemoria__ [da papà] Chiamarmi' });
    expect(fa.rows[0]?.meta).toEqual({ from: PAPA, fromLabel: 'papà', toLabel: 'Giorgio' });
    // Avviso immediato a Giorgio: notifica salvata + scheda nelle sessioni connesse.
    expect(fa.notifications).toEqual([
      { userId: GIORGIO, title: 'papà ti ha messo un promemoria' },
    ]);
    expect(pushed).toEqual([{ userId: GIORGIO, title: 'Promemoria da papà' }]);
    // Elenchi: papà lo vede «per Giorgio», Giorgio «da papà».
    expect((await store.list(PAPA)).map((x) => [x.text, x.for, x.from])).toEqual([
      ['Chiamarmi', 'Giorgio', undefined],
    ]);
    expect((await store.list(GIORGIO)).map((x) => [x.text, x.for, x.from])).toEqual([
      ['Chiamarmi', undefined, 'papà'],
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

describe('promemoria ricorrenti e canali (v1.11)', () => {
  it('«ogni venerdì alle 9» diventa un cron, l’elenco mostra la prossima occorrenza; i canali non cambiano l’id', async () => {
    const auto = fakeAutomations();
    const store = createReminderStore({
      automations: auto.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
    });
    const addsBefore = (queue.add as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await store.create(PAPA, {
      text: 'andare in palestra',
      at: future,
      timezone: 'Europe/Rome',
      repeat: { kind: 'weekly', weekdays: [5], hour: 9, minute: 0 },
    });
    const row = auto.rows[0];
    expect(row?.trigger).toEqual({ type: 'cron', pattern: '0 9 * * 5' });
    expect(row?.meta).toMatchObject({
      repeatLabel: 'ogni venerdì alle 9',
      repeat: { kind: 'weekly' },
    });
    // Nessun job ritardato: lo pianifica il worker come ogni cron.
    expect((queue.add as ReturnType<typeof vi.fn>).mock.calls.length).toBe(addsBefore);
    const [listed] = await store.list(PAPA);
    expect(listed?.repeat).toEqual({ kind: 'weekly', weekdays: [5], hour: 9, minute: 0 });
    expect(listed?.at?.getTime()).toBeGreaterThan(Date.now());
    expect(
      new Intl.DateTimeFormat('it-IT', { weekday: 'long', timeZone: 'Europe/Rome' }).format(
        listed?.at,
      ),
    ).toBe('venerdì');
    const updated = await store.update(PAPA, r.id, { channels: { email: true, alarm: false } });
    expect(updated?.id).toBe(r.id);
    expect(updated?.channels).toEqual({ email: true, alarm: false });
    // Nuova ora: stessa ricorrenza, ore e minuti nuovi.
    const moved = await store.update(PAPA, r.id, { at: new Date('2026-10-23T16:30:00Z') });
    expect(auto.rows.at(-1)?.trigger).toEqual({ type: 'cron', pattern: '30 18 * * 5' });
    expect(moved?.channels).toEqual({ email: true, alarm: false });
  });
});

describe('appuntamento con preavviso (v1.13)', () => {
  it('titolo con l’ora dell’appuntamento, etichetta «[tra …]» nello scatto, eventAt in elenco; decade se l’avviso slitta oltre', async () => {
    const fa = fakeAutomations();
    const store = createReminderStore({
      automations: fa.repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 1,
    });
    const at = new Date(Date.now() + 2 * 3_600_000);
    const eventAt = new Date(Date.now() + 3 * 3_600_000);
    const r = await store.create(PAPA, {
      text: 'il dentista',
      at,
      timezone: 'Europe/Rome',
      eventAt,
    });
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(eventAt);
    expect(r.text).toBe(`Il dentista alle ${hm}`);
    expect(r.eventAt?.getTime()).toBe(Math.floor(eventAt.getTime() / 1000) * 1000);
    const row = fa.rows[0];
    expect(row?.action.type === 'skill' ? row.action.input : '').toBe(
      `__promemoria__ [tra un'ora] Il dentista alle ${hm}`,
    );
    expect((await store.list(PAPA))[0]?.eventAt?.toISOString()).toBe(r.eventAt?.toISOString());
    // Un appuntamento che ha già l’ora nel testo non la ripete.
    const twice = await store.create(PAPA, {
      text: 'riunione alle 10',
      at,
      timezone: 'Europe/Rome',
      eventAt,
      literalTitle: true,
    });
    expect(twice.text).toBe('riunione alle 10');
    // Avviso spostato dopo l’appuntamento: non è più un preavviso.
    const moved = await store.update(PAPA, r.id, { at: new Date(eventAt.getTime() + 600_000) });
    expect(moved).not.toBeNull();
    expect(moved).not.toHaveProperty('eventAt');
    // Avviso spostato ma sempre prima: il preavviso resta e l’etichetta si ricalcola.
    const r2 = await store.create(PAPA, { text: 'visita', at, timezone: 'Europe/Rome', eventAt });
    const earlier = await store.update(PAPA, r2.id, {
      at: new Date(eventAt.getTime() - 1_800_000),
    });
    expect(earlier?.eventAt?.toISOString()).toBe(r2.eventAt?.toISOString());
    const row2 = fa.rows.find((a) => a.id === earlier?.id);
    expect(row2?.action.type === 'skill' ? row2.action.input : '').toContain('[tra 30 minuti]');
  });
});

describe('promemoria legati a un luogo (15 ott 2026)', () => {
  it('senza ora né job: luogo dalla scheda per etichetta, in fondo all’elenco; testo modificabile, stesso luogo', async () => {
    const { repo, rows } = fakeAutomations();
    const places: Array<{
      id: string;
      label: string;
      address?: string;
      lat?: number;
      lng?: number;
    }> = [{ id: 'p1', label: 'casa', address: 'via Roma 3, Treviso' }];
    const store = createReminderStore({
      automations: repo,
      queue,
      knownTools: [],
      maxBudgetUsd: 0.05,
      family: fakeFamily(),
      places: {
        list: async () => places,
        set: async (_u, input) => {
          places.push({ id: 'p2', ...input });
          return input;
        },
      },
    });
    const addsBefore = (queue.add as ReturnType<typeof vi.fn>).mock.calls.length;
    const r = await store.create(PAPA, {
      text: 'comprare il latte',
      timezone: 'Europe/Rome',
      place: { label: 'casa', on: 'arrive' },
    });
    expect(r.at).toBeUndefined();
    expect(r.place).toMatchObject({
      label: 'casa',
      on: 'arrive',
      placeId: 'p1',
      address: 'via Roma 3, Treviso',
    });
    expect(rows.at(-1)?.trigger).toEqual({
      type: 'place',
      label: 'casa',
      on: 'arrive',
      repeat: false,
    });
    expect((queue.add as ReturnType<typeof vi.fn>).mock.calls.length).toBe(addsBefore);

    await store.create(PAPA, { text: 'uscire', at: future, timezone: 'Europe/Rome' });
    const list = await store.list(PAPA);
    expect(list.map((x) => x.text)).toEqual(['Uscire', 'Comprare il latte']);
    // Coordinate trovate dal telefono: compaiono nell'elenco.
    places[0] = { ...places[0], id: 'p1', label: 'casa', lat: 45.66, lng: 12.24 };
    expect((await store.list(PAPA))[1]?.place).toMatchObject({
      lat: 45.66,
      lng: 12.24,
      radius: 150,
    });
    expect(await store.findPlace?.(PAPA, 'casa')).toMatchObject({ located: true });
    expect(await store.findPlace?.(PAPA, 'palestra')).toBeNull();

    const edited = await store.update(PAPA, r.id, { text: 'comprare il pane' });
    expect(edited?.text).toBe('comprare il pane');
    expect(edited?.place).toMatchObject({ label: 'casa', on: 'arrive' });
    // A un familiare: per ora no.
    await expect(
      store.create(PAPA, {
        text: 'compiti',
        timezone: 'Europe/Rome',
        forLabel: 'Giorgio',
        place: { label: 'casa', on: 'arrive' },
      }),
    ).rejects.toBeInstanceOf(UnknownPersonError);
    expect(
      await store.setPlace?.(PAPA, { label: 'lavoro', address: 'corso Italia 10, Roma' }),
    ).toEqual({
      label: 'lavoro',
      address: 'corso Italia 10, Roma',
    });
  });
});
