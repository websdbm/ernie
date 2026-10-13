import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from './registry.js';
import {
  createReminderSkill,
  formatWhen,
  parseReminderCommand,
  REMINDER_FIRE_PREFIX,
  type Reminder,
  type ReminderStore,
  reminderFollowUp,
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
    expect(p.assumed).toEqual([]); // «oggi» lo dice già la data
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

describe('titolo e frase di conferma dei promemoria', () => {
  it('pulizia deterministica dei giri di parole del parlato', async () => {
    const { tidyReminderText } = await import('./reminder.js');
    expect(tidyReminderText('uscire per andare a prendere Giorgio e portare la visita')).toBe(
      'Prendere Giorgio e portare la visita',
    );
    expect(tidyReminderText('andare a lavoro')).toBe('Andare al lavoro');
    expect(tidyReminderText('devo chiamare il dentista')).toBe('Chiamare il dentista');
    expect(tidyReminderText('uscire')).toBe('Uscire');
  });

  it('nessuna parentesi annidata: le stime in una frase a parte', async () => {
    const { createReminderSkill } = await import('./reminder.js');
    const store = {
      create: async (_u: string, i: { text: string; at: Date }) => ({
        id: 'r1',
        text: 'Prendere Giorgio e portarlo alla visita',
        at: i.at,
        status: 'scheduled' as const,
      }),
      list: async () => [],
      remove: async () => true,
      update: async () => null,
    };
    const skill = createReminderSkill(store, TZ);
    const exact = parseReminderCommand('ricordami a mezzogiorno di prendere Giorgio', NOW, TZ);
    const r1 = await skill.run(exact, { userId: 'u', sessionId: null, requestId: 'x' });
    expect(r1.text).toContain('⏰ Va bene: ti ricordo di prendere Giorgio e portarlo alla visita ');
    expect(r1.text).toContain(' alle 12:00.');
    expect(r1.text).not.toContain('(');
    const guess = parseReminderCommand('ricordami stasera di prendere Giorgio', NOW, TZ);
    const r2 = await skill.run(guess, { userId: 'u', sessionId: null, requestId: 'x' });
    expect(r2.text).toContain('Ho inteso le 20 per «sera».');
    expect(r2.text).not.toContain('(');
  });
});

describe('promemoria: data in lettere e risposta alla domanda «a che ora?»', () => {
  it('«il due novembre» in lettere: giorno capito, ora predefinita dichiarata, testo pulito', () => {
    const p = parseReminderCommand(
      'Ricordami il due novembre di fatturare alla pizzeria romana 900 euro',
      NOW,
      TZ,
    );
    expect(p?.op).toBe('create');
    if (p?.op !== 'create') return;
    expect(p.text).toBe('fatturare alla pizzeria romana 900 euro');
    expect(local(p.at)).toBe('2026-11-02 09:00');
    expect(p.assumed).toEqual(['le 9, perché non hai detto l’ora']);
    const q = parseReminderCommand(
      'ricordami il ventitré dicembre alle 18 di comprare il panettone',
      NOW,
      TZ,
    );
    expect(q?.op === 'create' && local(q.at)).toBe('2026-12-23 18:00');
    const r = parseReminderCommand('ricordami per il primo dicembre di pagare la rata', NOW, TZ);
    expect(r?.op === 'create' && local(r.at)).toBe('2026-12-01 09:00');
  });

  it('«alle 9» dopo la domanda completa il promemoria; altro contenuto lo lascia cadere', () => {
    const ask = parseReminderCommand('ricordami di fatturare alla pizzeria', NOW, TZ);
    expect(ask).toMatchObject({ op: 'ask_time', text: 'fatturare alla pizzeria' });
    const awaiting = { text: 'fatturare alla pizzeria' };
    const done = reminderFollowUp(awaiting, 'Alle 9', NOW, TZ);
    expect(done?.op).toBe('create');
    if (done?.op !== 'create') return;
    expect(done.text).toBe('fatturare alla pizzeria');
    // Sabato alle 15 le 9 sono passate: domani, e lo dice.
    expect(local(done.at)).toBe('2026-10-12 09:00');
    expect(done.assumed).toEqual(['domani, perché oggi quell’ora è già passata']);
    expect(reminderFollowUp(awaiting, 'ok, domani alle 8 grazie', NOW, TZ)?.op).toBe('create');
    expect(reminderFollowUp(awaiting, 'che tempo fa domani?', NOW, TZ)).toBeNull();
    expect(reminderFollowUp(awaiting, 'alle 9 chiama anche Mario', NOW, TZ)).toBeNull();
    expect(reminderFollowUp(null, 'alle 9', NOW, TZ)).toBeNull();
  });

  it('la domanda della skill porta con sé il promemoria in sospeso', async () => {
    const skill = createReminderSkill(null, TZ);
    const plan = skill.match('ricordami di fatturare alla pizzeria');
    const reply = await skill.run(plan, { userId: 'u', sessionId: 's', requestId: 'r' });
    expect(reply.text).toContain(
      'A che ora te lo ricordo? Il promemoria è «Fatturare alla pizzeria».',
    );
    expect(reply.awaiting).toEqual({ kind: 'time', text: 'fatturare alla pizzeria' });
    expect(skill.followUp?.(reply.awaiting, 'alle 17')).toMatchObject({
      op: 'create',
      text: 'fatturare alla pizzeria',
    });
  });
});

describe('promemoria: email nella scheda', () => {
  it('«la mia email è …», «cambia la mia email in …», «usa … come email»', () => {
    expect(parseReminderCommand('La mia email è Ale.Grassi@Example.com', NOW, TZ)).toEqual({
      op: 'set_email',
      email: 'ale.grassi@example.com',
    });
    expect(parseReminderCommand('cambia la mia mail in nuovo@posta.it.', NOW, TZ)).toEqual({
      op: 'set_email',
      email: 'nuovo@posta.it',
    });
    expect(parseReminderCommand('usa io@casa.org come email', NOW, TZ)).toEqual({
      op: 'set_email',
      email: 'io@casa.org',
    });
    expect(parseReminderCommand('la mia email è sbagliata', NOW, TZ)).toBeNull();
  });

  it('«…e mandamelo per email» accende il canale; senza indirizzo lo chiede e la risposta lo salva', async () => {
    const plan = parseReminderCommand(
      'ricordami domani alle 9 di pagare il bollo e mandamelo per email',
      NOW,
      TZ,
    );
    expect(plan).toMatchObject({ op: 'create', text: 'pagare il bollo', email: true });
    let saved: string | null = null;
    const created: Array<{ channels?: unknown }> = [];
    const store: ReminderStore = {
      create: async (_u, i) => {
        created.push(i);
        return {
          id: 'r1',
          text: i.text,
          at: i.at,
          status: 'scheduled',
          ...(i.channels ? { channels: i.channels } : {}),
        };
      },
      list: async () => [],
      remove: async () => false,
      update: async () => null,
      emailAddress: async () => saved,
      setEmail: async (_u, e) => {
        saved = e;
        return true;
      },
    };
    const skill = createReminderSkill(store, TZ);
    const reply = await skill.run(plan, { userId: 'u', sessionId: 's', requestId: 'r' });
    expect(created[0]?.channels).toEqual({ email: true });
    expect(reply.text).toContain('mi serve il tuo indirizzo');
    expect(reply.awaiting).toEqual({ kind: 'email' });
    const answer = skill.followUp?.(reply.awaiting, 'certo, è ale@example.com');
    expect(answer).toEqual({ op: 'set_email', email: 'ale@example.com' });
    const done = await skill.run(answer, { userId: 'u', sessionId: 's', requestId: 'r' });
    expect(saved).toBe('ale@example.com');
    expect(done.text).toContain('ho salvato ale@example.com nella tua scheda');
    // Con l'indirizzo già noto non chiede nulla; sostituendolo lo dice.
    const again = await skill.run(plan, { userId: 'u', sessionId: 's', requestId: 'r' });
    expect(again.awaiting).toBeUndefined();
    const changed = await skill.run(
      { op: 'set_email', email: 'nuova@example.com' },
      { userId: 'u', sessionId: 's', requestId: 'r' },
    );
    expect(changed.text).toContain('ho sostituito ale@example.com con nuova@example.com');
  });
});

describe('sveglia: promemoria che suona sul telefono, senza email', () => {
  // Martedì 13 ottobre 2026, 22:44 a Roma (come nello screenshot dell'utente).
  const LATE = zonedToUtc(TZ, 2026, 10, 13, 22, 44);

  it('«Senti domani, svegliami per le sei» → domani alle 6, sveglia accesa', () => {
    const p = parseReminderCommand('Senti domani, svegliami per le sei.', LATE, TZ);
    expect(p).toMatchObject({ op: 'create', text: 'Sveglia', alarm: true });
    if (p?.op !== 'create') throw new Error('piano');
    expect(local(p.at)).toBe('2026-10-14 06:00');
  });

  it('riconosce le forme comuni e capisce le ore in lettere', () => {
    const at = (t: string) => {
      const p = parseReminderCommand(t, LATE, TZ);
      return p?.op === 'create' ? `${local(p.at)}${p.alarm ? ' ⏰' : ''}` : p?.op;
    };
    expect(at('svegliami alle 6')).toBe('2026-10-14 06:00 ⏰');
    expect(at('metti la sveglia alle 7 e mezza')).toBe('2026-10-14 07:30 ⏰');
    expect(at('mi imposti una sveglia per le sette')).toBe('2026-10-14 07:00 ⏰');
    expect(at('sveglia domani alle 5:45')).toBe('2026-10-14 05:45 ⏰');
    expect(at('svegliami tra 20 minuti')).toBe('2026-10-13 23:04 ⏰');
    expect(at('svegliami')).toBe('ask_time');
    // «sveglia» come nome in altre frasi non è una richiesta di sveglia.
    expect(parseReminderCommand('la sveglia non ha suonato', LATE, TZ)).toBeNull();
    // Le ore in lettere valgono anche per i promemoria.
    expect(at('ricordami domani alle otto di chiamare Luca')).toBe('2026-10-14 08:00');
  });

  it('sveglia ricorrente e motivo tenuto nel titolo', () => {
    const r = parseReminderCommand('ogni giorno svegliami alle 7', LATE, TZ);
    expect(r).toMatchObject({
      op: 'create',
      alarm: true,
      repeat: { kind: 'daily', hour: 7, minute: 0 },
    });
    const why = parseReminderCommand('svegliami alle 5 che devo prendere il treno', LATE, TZ);
    expect(why).toMatchObject({
      op: 'create',
      text: 'Sveglia: Devo prendere il treno',
      alarm: true,
    });
  });

  it('la skill crea il promemoria con sveglia accesa ed email spenta, e lo dice', async () => {
    const create = vi.fn(async (_u: string, input: { text: string; at: Date }) => ({
      id: '00000000-0000-4000-8000-000000000009',
      text: input.text,
      at: input.at,
      status: 'scheduled' as const,
    }));
    const store: ReminderStore = {
      create,
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      update: vi.fn(async () => null),
    };
    const skill = createReminderSkill(store, TZ);
    const plan = parseReminderCommand('svegliami domani alle 6', LATE, TZ);
    const reply = await skill.run(plan, { userId: 'u', sessionId: null, requestId: 'r' });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ channels: { alarm: true, email: false } });
    expect(reply.text).toMatch(
      /^⏰ Sveglia domani alle 06:00\. Suona sul telefono come una sveglia/,
    );
    expect(reply.blocks?.[0]).toMatchObject({ kind: 'reminders', title: 'Sveglia' });
  });

  it('«a che ora ti sveglio?» → la risposta «alle 6» completa la sveglia', () => {
    const p = reminderFollowUp(
      { kind: 'time', text: 'Sveglia', alarm: true },
      'alle sei',
      LATE,
      TZ,
    );
    expect(p).toMatchObject({ op: 'create', text: 'Sveglia', alarm: true });
  });
});
