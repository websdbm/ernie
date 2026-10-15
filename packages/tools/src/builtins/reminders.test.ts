import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types.js';
import { createReminderTools, type ReminderToolInfo, type ReminderToolStore } from './reminders.js';

const ctx = (tz?: string): ToolContext =>
  ({
    userId: 'u1',
    sessionId: null,
    requestId: 'r1',
    scopes: ['chat'],
    run: {},
    ...(tz ? { device: { timezone: tz } } : {}),
  }) as unknown as ToolContext;

function fakeStore() {
  const created: Array<Parameters<ReminderToolStore['create']>[1]> = [];
  const items: ReminderToolInfo[] = [];
  const store: ReminderToolStore = {
    create: async (_u, input) => {
      created.push(input);
      const r: ReminderToolInfo = {
        id: `id-${created.length}`,
        text: input.eventAt ? `${input.text} alle 19:00` : input.text,
        ...(input.at ? { at: input.at } : {}),
        ...(input.place ? { place: input.place } : {}),
        ...(input.eventAt ? { eventAt: input.eventAt } : {}),
        ...(input.forLabel ? { for: input.forLabel } : {}),
      };
      items.push(r);
      return r;
    },
    list: async () => items,
    setPlace: async (_u, input) => (input.label === 'pieno' ? null : input),
    remove: async (_u, id) => {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    },
  };
  return { store, created, items };
}

const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** Il blocco «reminders» restituito da un `present`, altrimenti null. */
function remindersBlock(b: unknown): { title: string; reminders: unknown[] } | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const x = b as { kind?: unknown; title?: unknown; reminders?: unknown };
  return x.kind === 'reminders' && typeof x.title === 'string' && Array.isArray(x.reminders)
    ? { title: x.title, reminders: x.reminders }
    : null;
}

describe('tool dei promemoria per il modello', () => {
  it('reminder_create: appuntamento con preavviso, fuso del telefono, scheda «Appuntamento»', async () => {
    const { store, created } = fakeStore();
    const [create] = createReminderTools(store);
    if (!create) throw new Error('tool mancante');
    const at = future(2);
    const eventAt = future(3);
    const out = (await create.execute(
      { text: 'Dentista', at, eventAt },
      ctx('America/New_York'),
    )) as {
      id: string;
      text: string;
      eventAt?: string;
    };
    expect(created[0]).toMatchObject({ text: 'Dentista', timezone: 'America/New_York' });
    expect(created[0]?.eventAt?.toISOString()).toBe(eventAt);
    expect(out.text).toBe('Dentista alle 19:00');
    expect(remindersBlock(create.present?.({ text: 'Dentista', at }, out))?.title).toBe(
      'Appuntamento',
    );
  });

  it('reminder_create: fuso non valido → predefinito; sveglia = canali alarm senza email; errori chiari', async () => {
    const { store, created } = fakeStore();
    const [create] = createReminderTools(store, { defaultTimezone: 'Europe/Rome' });
    if (!create) throw new Error('tool mancante');
    await create.execute({ text: 'Sveglia', at: future(8), alarm: true }, ctx('Marte/Olympus'));
    expect(created[0]).toMatchObject({
      timezone: 'Europe/Rome',
      channels: { alarm: true, email: false },
      literalTitle: true,
    });
    await expect(
      create.execute({ text: 'x', at: new Date(Date.now() - 60_000).toISOString() }, ctx()),
    ).rejects.toThrow(/già passata/);
    await expect(
      create.execute({ text: 'x', at: future(3), eventAt: future(2) }, ctx()),
    ).rejects.toThrow(/dopo l’avviso/);
  });

  it('reminder_list e reminder_cancel', async () => {
    const { store } = fakeStore();
    const [create, list, cancel] = createReminderTools(store);
    if (!create || !list || !cancel) throw new Error('tool mancanti');
    await create.execute({ text: 'Chiamare Luca', at: future(1) }, ctx());
    const listed = (await list.execute({}, ctx())) as { reminders: Array<{ id: string }> };
    expect(listed.reminders).toHaveLength(1);
    expect(remindersBlock(list.present?.({}, listed))?.reminders).toHaveLength(1);
    expect(await cancel.execute({ id: listed.reminders[0]?.id ?? '' }, ctx())).toEqual({
      removed: true,
    });
    expect(await cancel.execute({ id: 'nope' }, ctx())).toEqual({ removed: false });
    expect(list.present?.({}, { reminders: [] })).toBeNull();
  });
});

describe('promemoria legati a un luogo e luoghi della scheda', () => {
  it('reminder_create con place: niente ora, solo per l’utente; place_set salva l’indirizzo', async () => {
    const { store, created } = fakeStore();
    const tools = createReminderTools(store);
    const create = tools.find((t) => t.id === 'reminder_create');
    const placeSet = tools.find((t) => t.id === 'place_set');
    if (!create || !placeSet) throw new Error('tool mancanti');
    const out = (await create.execute(
      { text: 'Comprare il pane', place: { label: 'Casa', on: 'arrive' } },
      ctx('Europe/Rome'),
    )) as { place?: { label: string; on: string } };
    expect(out.place).toEqual({ label: 'casa', on: 'arrive' });
    expect(created.at(-1)).toMatchObject({ place: { label: 'casa', on: 'arrive' } });
    expect(created.at(-1)?.at).toBeUndefined();
    await expect(
      create.execute(
        { text: 'Compiti', place: { label: 'casa', on: 'arrive' }, forLabel: 'Giorgio' },
        ctx(),
      ),
    ).rejects.toThrow(/solo per l’utente/);
    await expect(create.execute({ text: 'Senza niente' }, ctx())).rejects.toThrow(/`at`/);
    expect(
      await placeSet.execute({ label: 'Casa', address: 'via Roma 3, Treviso' }, ctx()),
    ).toEqual({ label: 'casa', address: 'via Roma 3, Treviso' });
    await expect(
      placeSet.execute({ label: 'pieno', address: 'via Verdi 1, Milano' }, ctx()),
    ).rejects.toThrow(/dieci/);
  });
});
