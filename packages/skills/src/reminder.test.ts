import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from './registry.js';
import {
  createReminderSkill,
  formatWhen,
  parseReminderCommand,
  REMINDER_FIRE_PREFIX,
  type Reminder,
  type ReminderStore,
  UnknownPersonError,
} from './reminder.js';
import { localParts, zonedToUtc } from './zoned.js';

const TZ = 'Europe/Rome';
// Sabato 11 ottobre 2026, 15:00 a Roma (ora legale, UTC+2).
const NOW = zonedToUtc(TZ, 2026, 10, 11, 15, 0);
const local = (d: Date) => {
  const p = localParts(d, TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('parseReminderCommand', () => {
  it('oggi alle 17 (giorno omesso = oggi)', () => {
    const p = parseReminderCommand('Ricordami di uscire dal lavoro alle 17', NOW, TZ);
    expect(p?.op).toBe('create');
    if (p?.op !== 'create') return;
    expect(p.text).toBe('uscire dal lavoro');
    expect(local(p.at)).toBe('2026-10-11 17:00');
    expect(p.assumed).toEqual(['oggi']);
  });

  it('ora già passata → domani; orari con minuti, mezza, sera', () => {
    const p = parseReminderCommand('ricordami alle 9 di chiamare il dentista', NOW, TZ);
    if (p?.op !== 'create') throw new Error('atteso create');
    expect(local(p.at)).toBe('2026-10-12 09:00');
    expect(p.assumed[0]).toContain('domani');
    const q = parseReminderCommand(
      'ricordami di prendere la pizza alle 7 e mezza di sera',
      NOW,
      TZ,
    );
    if (q?.op !== 'create') throw new Error('atteso create');
    expect(local(q.at)).toBe('2026-10-11 19:30');
    const r = parseReminderCommand('ricordami domani alle 10:15 la riunione', NOW, TZ);
    if (r?.op !== 'create') throw new Error('atteso create');
    expect([r.text, local(r.at)]).toEqual(['la riunione', '2026-10-12 10:15']);
  });

  it('relativi, giorni della settimana, date esplicite, momenti della giornata', () => {
    const a = parseReminderCommand('tra 20 minuti ricordami di spegnere il forno', NOW, TZ);
    if (a?.op !== 'create') throw new Error('atteso create');
    expect([a.text, local(a.at)]).toEqual(['spegnere il forno', '2026-10-11 15:20']);
    const b = parseReminderCommand("ricordami fra un'ora di bere", NOW, TZ);
    if (b?.op !== 'create') throw new Error('atteso create');
    expect(local(b.at)).toBe('2026-10-11 16:00');
    const c = parseReminderCommand('ricordami lunedì alle 8 di portare fuori il vetro', NOW, TZ);
    if (c?.op !== 'create') throw new Error('atteso create');
    expect([c.text, local(c.at)]).toEqual(['portare fuori il vetro', '2026-10-12 08:00']);
    const d = parseReminderCommand(
      'ricordami il 15 ottobre alle 10:30 di pagare la bolletta',
      NOW,
      TZ,
    );
    if (d?.op !== 'create') throw new Error('atteso create');
    expect([d.text, local(d.at)]).toEqual(['pagare la bolletta', '2026-10-15 10:30']);
    const e = parseReminderCommand('ricordami il 3/1 di fare gli auguri', NOW, TZ);
    if (e?.op !== 'create') throw new Error('atteso create');
    expect(local(e.at)).toBe('2027-01-03 09:00');
    const f = parseReminderCommand('ricordami stasera di chiamare mamma', NOW, TZ);
    if (f?.op !== 'create') throw new Error('atteso create');
    expect([f.text, local(f.at)]).toEqual(['chiamare mamma', '2026-10-11 20:00']);
    const g = parseReminderCommand('ricordami domani mattina di comprare il pane', NOW, TZ);
    if (g?.op !== 'create') throw new Error('atteso create');
    expect([g.text, local(g.at)]).toEqual(['comprare il pane', '2026-10-12 09:00']);
  });

  it('senza ora chiede; elenco, annullamento, scatto', () => {
    expect(parseReminderCommand('ricordami di chiamare Marco', NOW, TZ)).toEqual({
      op: 'ask_time',
      text: 'chiamare Marco',
    });
    expect(parseReminderCommand('che promemoria ho?', NOW, TZ)).toEqual({ op: 'list' });
    expect(parseReminderCommand('annulla il promemoria delle 17', NOW, TZ)).toEqual({
      op: 'cancel',
      what: 'delle 17',
    });
    expect(parseReminderCommand(`${REMINDER_FIRE_PREFIX}uscire dal lavoro`, NOW, TZ)).toEqual({
      op: 'fire',
      text: 'uscire dal lavoro',
    });
    expect(parseReminderCommand('cosa cucino stasera?', NOW, TZ)).toBeNull();
    expect(parseReminderCommand('mi ricordo di te', NOW, TZ)).toBeNull();
  });

  it('formatta gli orari in modo parlante', () => {
    expect(formatWhen(zonedToUtc(TZ, 2026, 10, 11, 17, 0), TZ, NOW)).toBe('oggi alle 17:00');
    expect(formatWhen(zonedToUtc(TZ, 2026, 10, 12, 9, 0), TZ, NOW)).toBe('domani alle 09:00');
    expect(formatWhen(zonedToUtc(TZ, 2026, 10, 14, 8, 0), TZ, NOW)).toBe('mercoledì alle 08:00');
    expect(formatWhen(zonedToUtc(TZ, 2026, 11, 2, 8, 0), TZ, NOW)).toBe(
      'lunedì 2 novembre alle 08:00',
    );
  });
});

describe('promemoria a una persona collegata (Famiglia)', () => {
  it('«ricorda a Giorgio di …» e «promemoria per Giorgio: …» portano il destinatario', () => {
    const p = parseReminderCommand('ricorda a Giorgio di chiamarmi alle 17 di domani', NOW, TZ);
    expect(p).toMatchObject({ op: 'create', who: 'Giorgio', text: 'chiamarmi' });
    if (p?.op === 'create') expect(local(p.at)).toBe('2026-10-12 17:00');
    const q = parseReminderCommand(
      'promemoria per zio Mario: portare il dolce domenica alle 12',
      NOW,
      TZ,
    );
    expect(q).toMatchObject({ op: 'create', who: 'zio Mario', text: 'portare il dolce' });
    const r = parseReminderCommand(
      'ricorda a Giorgio che domani alle 8 deve prendere il libro',
      NOW,
      TZ,
    );
    expect(r).toMatchObject({ op: 'create', who: 'Giorgio', text: 'deve prendere il libro' });
    // «ricordami di chiamare Giorgio» resta un promemoria mio.
    const mine = parseReminderCommand('ricordami di chiamare Giorgio alle 18', NOW, TZ);
    expect(mine).toMatchObject({ op: 'create', text: 'chiamare Giorgio' });
    expect((mine as { who?: string }).who).toBeUndefined();
    const fire = parseReminderCommand(`${REMINDER_FIRE_PREFIX}[da papà] chiamarmi`, NOW, TZ);
    expect(fire).toEqual({ op: 'fire', text: 'chiamarmi', from: 'papà' });
  });

  it('lo store riceve forLabel; etichetta sconosciuta → risposta che spiega come collegarla', async () => {
    const store: ReminderStore = {
      create: vi.fn(async (_u, input) => {
        if (input.forLabel && input.forLabel !== 'Giorgio')
          throw new UnknownPersonError(input.forLabel);
        return {
          id: '00000000-0000-4000-8000-000000000009',
          text: input.text,
          at: input.at,
          status: 'scheduled' as const,
          ...(input.forLabel ? { for: input.forLabel } : {}),
        };
      }),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      update: vi.fn(async () => null),
    };
    const skill = createReminderSkill(store, TZ);
    const ctx = { userId: 'u', sessionId: null, requestId: 'r' };
    const ok = await skill.run(skill.match('ricorda a Giorgio di chiamarmi domani alle 17'), ctx);
    expect(ok.text).toContain('ricordo a Giorgio di chiamarmi domani alle 17:00');
    expect(ok.blocks?.[0]).toMatchObject({
      kind: 'reminders',
      title: 'Promemoria per Giorgio',
      reminders: [{ for: 'Giorgio' }],
    });
    const ko = await skill.run(skill.match('ricorda a Marco di chiamarmi domani alle 17'), ctx);
    expect(ko.text).toContain('Non conosco nessun «Marco»');
    const fired = await skill.run(skill.match(`${REMINDER_FIRE_PREFIX}[da papà] chiamarmi`), ctx);
    expect(fired.text).toBe('⏰ Promemoria da papà: chiamarmi');
  });
});

describe('skill ricordami', () => {
  it('crea, elenca, annulla e scatta con lo store finto', async () => {
    const saved: Reminder[] = [];
    const store: ReminderStore = {
      create: vi.fn(async (_u, input) => {
        const r: Reminder = {
          id: `00000000-0000-4000-8000-00000000000${saved.length + 1}`,
          text: input.text,
          at: input.at,
          status: 'scheduled',
        };
        saved.push(r);
        return r;
      }),
      list: vi.fn(async () => saved.filter((r) => r.status === 'scheduled')),
      remove: vi.fn(async (_u, id) => {
        const i = saved.findIndex((r) => r.id === id);
        if (i < 0) return false;
        saved.splice(i, 1);
        return true;
      }),
      update: vi.fn(async () => null),
    };
    const registry = new SkillRegistry().register(createReminderSkill(store, TZ));
    const ctx = { userId: 'u', sessionId: null, requestId: 'r' };
    const m = registry.match('ricordami di uscire alle 23:59');
    expect(m?.skill.id).toBe('ricordami');
    const reply = await m?.skill.run(m.plan, ctx);
    expect(reply?.text).toContain('ti ricordo di uscire');
    expect(reply?.blocks?.[0]).toMatchObject({ kind: 'reminders' });
    const l = registry.match('che promemoria ho?');
    expect((await l?.skill.run(l.plan, ctx))?.text).toContain('uscire');
    const c = registry.match('annulla il promemoria delle 23:59');
    expect((await c?.skill.run(c.plan, ctx))?.text).toBe('Annullato: uscire.');
    expect(saved).toEqual([]);
    const f = registry.match(`${REMINDER_FIRE_PREFIX}uscire`);
    expect((await f?.skill.run(f.plan, ctx))?.text).toBe('⏰ Promemoria: uscire');
    const fire = createReminderSkill(null, TZ);
    expect((await fire.run({ op: 'fire', text: 'bere' }, ctx)).text).toBe('⏰ Promemoria: bere');
  });
});
