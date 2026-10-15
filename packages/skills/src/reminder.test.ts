import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from './registry.js';
import {
  addressLike,
  createReminderSkill,
  formatWhen,
  leadQuantity,
  parseAppointment,
  parseReminderCommand,
  placePhrase,
  REMINDER_FIRE_PREFIX,
  type Reminder,
  type ReminderStore,
  reminderFollowUp,
  toRemindersBlock,
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
          ...(input.at ? { at: input.at } : {}),
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
          ...(input.at ? { at: input.at } : {}),
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
      create: async (_u: string, i: { text: string; at?: Date }) => ({
        id: 'r1',
        text: 'Prendere Giorgio e portarlo alla visita',
        ...(i.at ? { at: i.at } : {}),
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
          ...(i.at ? { at: i.at } : {}),
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
    const create = vi.fn(async (_u: string, input: { text: string; at?: Date }) => ({
      id: '00000000-0000-4000-8000-000000000009',
      text: input.text,
      ...(input.at ? { at: input.at } : {}),
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
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      channels: { alarm: true, email: false },
      literalTitle: true,
    });
    expect(reply.text).toMatch(/^⏰ Sveglia .+ alle 06:00\. Suona sul telefono come una sveglia/);
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

describe('appuntamento con preavviso (richiesta del 15 ott 2026)', () => {
  const plan = (t: string) => {
    const p = parseReminderCommand(t, NOW, TZ);
    if (p?.op !== 'create') throw new Error(`atteso create per «${t}», avuto ${p?.op ?? 'null'}`);
    return {
      text: p.text,
      at: local(p.at),
      event: p.eventAt ? local(p.eventAt) : null,
      assumed: p.assumed,
    };
  };

  it('«ho il dentista alle 19, avvertimi alle 18» → avviso alle 18, appuntamento alle 19', () => {
    expect(plan('Ho il dentista alle 19, avvertimi alle 18.')).toMatchObject({
      text: 'il dentista',
      at: '2026-10-11 18:00',
      event: '2026-10-11 19:00',
    });
  });

  it('ora dell’avviso ambigua: «alle 6» per le 7 di sera sono le 18, non le 6 del mattino', () => {
    expect(plan('ho il dentista alle 7 del pomeriggio, avvisami alle 6')).toMatchObject({
      at: '2026-10-11 18:00',
      event: '2026-10-11 19:00',
    });
    // Appuntamento di mattina: l’avviso può cadere la sera prima.
    expect(plan('domani alle 9 ho il dentista, avvisami alle 21')).toMatchObject({
      at: '2026-10-11 21:00',
      event: '2026-10-12 09:00',
    });
  });

  it('preavviso relativo: mezz’ora, un’ora, un quarto d’ora, due ore, il giorno prima; «prima» = un’ora', () => {
    expect(plan("domani alle 10 ho la riunione, ricordamelo mezz'ora prima")).toMatchObject({
      text: 'la riunione',
      at: '2026-10-12 09:30',
      event: '2026-10-12 10:00',
    });
    expect(plan("avvisami un'ora prima che alle 17 c'è la visita dal medico")).toMatchObject({
      text: 'la visita dal medico',
      at: '2026-10-11 16:00',
      event: '2026-10-11 17:00',
    });
    expect(
      plan("alle 18 devo andare dal commercialista, avvertimi un quarto d'ora prima"),
    ).toMatchObject({
      text: 'dal commercialista',
      at: '2026-10-11 17:45',
    });
    expect(plan('lunedì alle 15 ho il colloquio, avvisami due ore prima').at).toBe(
      '2026-10-12 13:00',
    );
    expect(plan('il 20 ottobre alle 11 ho la revisione, ricordamelo il giorno prima').at).toBe(
      '2026-10-19 11:00',
    );
    // Segnalato dall'utente il 15 ott 2026: «ricordami» in testa e il preavviso in una seconda frase.
    expect(
      plan(
        'Ricordami domani di uscire alle 17:00 per andare a prendere il treno. ricordamelo 10 minuti prima.',
      ),
    ).toMatchObject({
      text: 'uscire per andare a prendere il treno',
      at: '2026-10-12 16:50',
      event: '2026-10-12 17:00',
    });
    expect(plan('ricordami alle 18 di chiamare Luca, avvisami 5 minuti prima')).toMatchObject({
      text: 'chiamare Luca',
      at: '2026-10-11 17:55',
      event: '2026-10-11 18:00',
    });
    const bare = plan('ho il dentista alle 19, avvisami prima');
    expect(bare.at).toBe('2026-10-11 18:00');
    expect(bare.assumed.join(' ')).toContain("un'ora di preavviso");
  });

  it('non scatta senza l’ora dell’appuntamento, con un avviso già passato o dopo l’appuntamento', () => {
    expect(parseAppointment('ho il dentista, avvisami alle 18', NOW, TZ)).toBeNull();
    // Avviso alle 14 di oggi (già passato alle 15): nessun candidato valido.
    expect(parseAppointment('ho il dentista alle 16, avvisami alle 14', NOW, TZ)).toBeNull();
    // Il parser generale resta valido per i promemoria semplici.
    expect(parseReminderCommand('ricordami alle 18 di chiamare Luca', NOW, TZ)).toMatchObject({
      op: 'create',
      text: 'chiamare Luca',
    });
    expect(parseReminderCommand('ricordami alle 18 di chiamare Luca', NOW, TZ)).not.toHaveProperty(
      'eventAt',
    );
  });

  it('scatto: «[tra un’ora]» e «[da papà]» in testa, in qualsiasi ordine', () => {
    expect(parseReminderCommand(`${REMINDER_FIRE_PREFIX}[tra un'ora] Dentista alle 19:00`)).toEqual(
      {
        op: 'fire',
        text: 'Dentista alle 19:00',
        lead: "tra un'ora",
      },
    );
    expect(
      parseReminderCommand(`${REMINDER_FIRE_PREFIX}[da papà] [tra 30 minuti] Visita alle 17:00`),
    ).toEqual({ op: 'fire', text: 'Visita alle 17:00', from: 'papà', lead: 'tra 30 minuti' });
    expect(parseReminderCommand(`${REMINDER_FIRE_PREFIX}Bere acqua`)).toEqual({
      op: 'fire',
      text: 'Bere acqua',
    });
  });

  it('quantità del preavviso e blocco con eventAt; risposta della skill', async () => {
    expect(leadQuantity(60_000)).toBe('un minuto');
    expect(leadQuantity(30 * 60_000)).toBe('30 minuti');
    expect(leadQuantity(3_600_000)).toBe("un'ora");
    expect(leadQuantity(90 * 60_000)).toBe("un'ora e mezza");
    expect(leadQuantity(2 * 3_600_000)).toBe('2 ore');
    expect(leadQuantity(24 * 3_600_000)).toBe('un giorno');
    expect(leadQuantity(135 * 60_000)).toBe('2 ore e 15 minuti');

    const created: Array<Parameters<ReminderStore['create']>[1]> = [];
    const store: ReminderStore = {
      create: async (_u, input) => {
        created.push(input);
        return {
          id: '11111111-1111-4111-8111-111111111111',
          text: 'Dentista alle 19:00',
          ...(input.at ? { at: input.at } : {}),
          status: 'scheduled',
          ...(input.eventAt ? { eventAt: input.eventAt } : {}),
        };
      },
      list: async () => [],
      remove: async () => true,
      update: async () => null,
    };
    const skill = createReminderSkill(store, TZ);
    const p = parseReminderCommand('ho il dentista alle 19, avvertimi alle 18', NOW, TZ);
    const reply = await skill.run(p, { userId: 'u1', sessionId: null } as never);
    expect(created[0]?.eventAt && local(created[0].eventAt)).toBe('2026-10-11 19:00');
    // formatWhen usa la data reale per «oggi»/«domani»: qui contano l'ora e il preavviso.
    expect(reply.text).toMatch(
      /^⏰ Va bene: Dentista alle 19:00\. Ti avviso .* alle 18:00, un'ora prima\.$/,
    );
    const block = reply.blocks?.[0];
    if (block?.kind !== 'reminders') throw new Error('atteso blocco promemoria');
    expect(block.reminders[0]?.eventAt).toBe('2026-10-11T17:00:00.000Z');
    const plain = toRemindersBlock([{ id: 'x', text: 'y', at: NOW, status: 'done' }]);
    if (plain.kind !== 'reminders') throw new Error('atteso blocco promemoria');
    expect(plain.reminders[0]).not.toHaveProperty('eventAt');

    const fired = await skill.run(
      parseReminderCommand(`${REMINDER_FIRE_PREFIX}[tra un'ora] Dentista alle 19:00`),
      { userId: 'u1', sessionId: null } as never,
    );
    expect(fired.text).toBe("⏰ Tra un'ora: Dentista alle 19:00");
  });
});

describe('promemoria legati a un luogo', () => {
  it('riconosce arrivo, uscita, «ogni volta» e il luogo in qualsiasi punto della frase', () => {
    expect(
      parseReminderCommand('ricordami di comprare il latte quando arrivo a casa', NOW, TZ),
    ).toEqual({
      op: 'create_place',
      text: 'comprare il latte',
      place: { label: 'casa', on: 'arrive', repeat: false },
    });
    expect(
      parseReminderCommand('Quando arrivo al lavoro ricordami di chiamare Marco.', NOW, TZ),
    ).toMatchObject({
      op: 'create_place',
      text: 'chiamare Marco',
      place: { label: 'lavoro', on: 'arrive' },
    });
    expect(parseReminderCommand('quando esco di casa ricordami le chiavi', NOW, TZ)).toMatchObject({
      text: 'le chiavi',
      place: { label: 'casa', on: 'leave' },
    });
    expect(
      parseReminderCommand('ricordami quando torno a casa mia di chiamare la mamma', NOW, TZ),
    ).toMatchObject({
      text: 'chiamare la mamma',
      place: { label: 'casa', on: 'arrive' },
    });
    expect(
      parseReminderCommand('ogni volta che arrivo in palestra ricordami di bere', NOW, TZ),
    ).toMatchObject({
      place: { label: 'palestra', on: 'arrive', repeat: true },
    });
    expect(
      parseReminderCommand("ricordami di stampare quando arrivo all'ufficio", NOW, TZ),
    ).toMatchObject({
      place: { label: 'ufficio' },
    });
    expect(
      parseReminderCommand('ricorda a Giorgio di fare i compiti quando arriva a casa', NOW, TZ),
    ).toEqual({
      op: 'place_other',
      who: 'Giorgio',
    });
    // Le richieste con un'ora restano com'erano.
    expect(parseReminderCommand('ricordami di uscire alle 17', NOW, TZ)).toMatchObject({
      op: 'create',
    });
  });

  it('salva un indirizzo detto in chat solo se sembra un indirizzo', () => {
    expect(parseReminderCommand('casa mia è in via Roma 3, Treviso', NOW, TZ)).toEqual({
      op: 'set_place',
      label: 'casa',
      address: 'via Roma 3, Treviso',
    });
    expect(parseReminderCommand('abito in piazza Duomo 1 a Milano', NOW, TZ)).toMatchObject({
      label: 'casa',
      address: 'piazza Duomo 1 a Milano',
    });
    expect(
      parseReminderCommand('il mio ufficio è in corso Italia 10, Roma', NOW, TZ),
    ).toMatchObject({
      label: 'ufficio',
    });
    expect(parseReminderCommand('lavoro in banca', NOW, TZ)).toBeNull();
    expect(parseReminderCommand('casa mia è bellissima', NOW, TZ)).toBeNull();
    expect(addressLike('Via Garibaldi 12')).toBe('Via Garibaldi 12');
    expect(placePhrase({ label: 'casa', on: 'arrive' })).toBe('quando arrivi a casa');
    expect(placePhrase({ label: 'lavoro', on: 'leave', repeat: true })).toBe(
      'ogni volta che esci dal lavoro',
    );
  });

  it('luogo sconosciuto: crea il promemoria e chiede l’indirizzo; la risposta lo salva', async () => {
    const created: Array<Parameters<ReminderStore['create']>[1]> = [];
    let place: { label: string; address: string } | null = null;
    const store: ReminderStore = {
      create: async (_u, input) => {
        created.push(input);
        return {
          id: '22222222-2222-4222-8222-222222222222',
          text: 'Comprare il latte',
          status: 'scheduled',
          ...(input.place ? { place: input.place } : {}),
        };
      },
      list: async () =>
        place
          ? [
              {
                id: '22222222-2222-4222-8222-222222222222',
                text: 'Comprare il latte',
                status: 'scheduled' as const,
                place: { label: 'casa', on: 'arrive' as const, address: place.address },
              },
            ]
          : [],
      remove: async () => true,
      update: async () => null,
      findPlace: async () =>
        place ? { label: 'casa', address: place.address, located: false } : null,
      setPlace: async (_u, input) => {
        place = input;
        return input;
      },
    };
    const skill = createReminderSkill(store, TZ);
    const ctx = { userId: 'u', sessionId: null, requestId: 'x' };
    const plan = parseReminderCommand(
      'ricordami di comprare il latte quando arrivo a casa',
      NOW,
      TZ,
    );
    const r1 = await skill.run(plan, ctx);
    expect(r1.text).toContain('📍 Va bene: quando arrivi a casa ti ricordo di comprare il latte.');
    expect(r1.text).toContain("non so ancora dov'è «casa»");
    expect(r1.awaiting).toEqual({ kind: 'place', label: 'casa' });
    expect(created[0]).toMatchObject({ place: { label: 'casa', on: 'arrive' } });
    expect(created[0]?.at).toBeUndefined();
    const block = r1.blocks?.[0];
    if (block?.kind !== 'reminders') throw new Error('atteso un blocco promemoria');
    expect(block.reminders[0]).toMatchObject({ place: { label: 'casa', on: 'arrive' } });
    expect(block.reminders[0]?.at).toBeUndefined();

    const follow = reminderFollowUp(r1.awaiting, 'via Roma 3, Treviso', NOW, TZ);
    expect(follow).toEqual({ op: 'set_place', label: 'casa', address: 'via Roma 3, Treviso' });
    expect(reminderFollowUp(r1.awaiting, 'boh, non lo so', NOW, TZ)).toBeNull();
    const r2 = await skill.run(follow, ctx);
    expect(r2.text).toContain('📍 Fatto: «casa» è in via Roma 3, Treviso.');
    expect(r2.text).toContain('Il promemoria «Comprare il latte» scatterà quando arrivi lì.');

    // Luogo noto ma non ancora sulla mappa: il telefono cerca la posizione.
    const r3 = await skill.run(plan, ctx);
    expect(r3.text).toContain('Il telefono cerca da solo la posizione di «via Roma 3, Treviso»');
    expect(r3.awaiting).toBeUndefined();

    const list = await skill.run({ op: 'list' }, ctx);
    expect(list.text).toContain('- Comprare il latte: quando arrivi a casa');
  });
});

describe('luogo trovato nel second brain', () => {
  it('la risposta dice da quale nota viene il luogo', async () => {
    const store: ReminderStore = {
      create: async (_u, input) => ({
        id: '33333333-3333-4333-8333-333333333333',
        text: 'Chiedere la ricevuta',
        status: 'scheduled',
        ...(input.place ? { place: input.place } : {}),
      }),
      list: async () => [],
      remove: async () => true,
      update: async () => null,
      findPlace: async () => ({
        label: 'dentista',
        address: 'corso Italia 10, Roma',
        located: false,
        fromNote: 'Studio dentistico Rossi',
      }),
    };
    const skill = createReminderSkill(store, TZ);
    const plan = parseReminderCommand(
      'ricordami di chiedere la ricevuta quando arrivo dal dentista',
      NOW,
      TZ,
    );
    expect(plan).toMatchObject({ op: 'create_place', place: { label: 'dentista' } });
    const r = await skill.run(plan, { userId: 'u', sessionId: null, requestId: 'x' });
    expect(r.text).toContain(
      'Ho preso «dentista» dal tuo second brain (nota «Studio dentistico Rossi», corso Italia 10, Roma).',
    );
    expect(r.awaiting).toBeUndefined();
  });
});

describe('frasi dei luoghi che sono persone', () => {
  it('«dal dentista», «dalla nonna», «dai nonni», «dallo psicologo»', () => {
    expect(placePhrase({ label: 'dentista', on: 'arrive' })).toBe('quando arrivi dal dentista');
    expect(placePhrase({ label: 'nonna', on: 'leave' })).toBe('quando esci dalla nonna');
    expect(placePhrase({ label: 'nonni', on: 'arrive', repeat: true })).toBe(
      'ogni volta che arrivi dai nonni',
    );
    expect(placePhrase({ label: 'psicologo', on: 'arrive' })).toBe('quando arrivi dallo psicologo');
    expect(placePhrase({ label: 'casa', on: 'arrive' })).toBe('quando arrivi a casa');
  });
});

describe('dare un nome ai luoghi in chat', () => {
  it('riconosce posizione attuale, indirizzo con un nome qualsiasi e rinomina', () => {
    expect(parseReminderCommand('salva questo posto come palestra', NOW, TZ)).toEqual({
      op: 'name_here',
      label: 'palestra',
    });
    expect(parseReminderCommand('Chiama questo posto «casa al mare»', NOW, TZ)).toEqual({
      op: 'name_here',
      label: 'casa al mare',
    });
    expect(parseReminderCommand('questo posto si chiama studio di Giulia', NOW, TZ)).toMatchObject({
      op: 'name_here',
      label: 'studio di Giulia',
    });
    expect(parseReminderCommand('segna dove sono adesso come parcheggio', NOW, TZ)).toMatchObject({
      label: 'parcheggio',
    });
    expect(parseReminderCommand('lo studio di Giulia è in via Verdi 10, Milano', NOW, TZ)).toEqual({
      op: 'set_place',
      label: 'studio di giulia',
      address: 'via Verdi 10, Milano',
    });
    expect(parseReminderCommand('la mia piscina è in viale Monza 5', NOW, TZ)).toMatchObject({
      label: 'piscina',
    });
    expect(
      parseReminderCommand('salva via Garibaldi 12, Padova come bar di Marco', NOW, TZ),
    ).toEqual({ op: 'set_place', label: 'bar di Marco', address: 'via Garibaldi 12, Padova' });
    expect(parseReminderCommand('rinomina dentista in studio Rossi', NOW, TZ)).toEqual({
      op: 'rename_place',
      from: 'dentista',
      to: 'studio Rossi',
    });
    // Un evento in un indirizzo non è un luogo da salvare.
    expect(parseReminderCommand('la riunione è in via Roma 3', NOW, TZ)).toBeNull();
  });

  it('nome lungo usato solo se è nella scheda; posizione attuale salvata dalla skill', async () => {
    const plan = parseReminderCommand(
      'ricordami di portare il libro quando arrivo allo studio di Giulia',
      NOW,
      TZ,
    );
    expect(plan).toMatchObject({
      op: 'create_place',
      place: { label: 'studio' },
      alt: { label: 'studio di giulia', text: 'portare il libro' },
    });
    const created: Array<Parameters<ReminderStore['create']>[1]> = [];
    let here: { label: string; lat: number } | null = null;
    const store: ReminderStore = {
      create: async (_u, input) => {
        created.push(input);
        return {
          id: '44444444-4444-4444-8444-444444444444',
          text: 'Portare il libro',
          status: 'scheduled',
          ...(input.place ? { place: input.place } : {}),
        };
      },
      list: async () => [],
      remove: async () => true,
      update: async () => null,
      findPlace: async (_u, label) =>
        label === 'studio di giulia' ? { label, located: true } : null,
      setPlaceHere: async (_u, input) => {
        here = input;
        return { label: input.label.toLowerCase(), moved: false };
      },
      renamePlace: async (_u, from, to) =>
        from === 'dentista'
          ? { ok: true, from, to: to.toLowerCase(), reminders: 2 }
          : { ok: false, reason: 'missing' },
    };
    const skill = createReminderSkill(store, TZ);
    const ctx = { userId: 'u', sessionId: null, requestId: 'x' };
    const r = await skill.run(plan, ctx);
    expect(created[0]).toMatchObject({
      text: 'portare il libro',
      place: { label: 'studio di giulia' },
    });
    expect(r.text).toContain('quando arrivi a «studio di giulia»');

    const noLoc = await skill.run({ op: 'name_here', label: 'palestra' }, ctx);
    expect(noLoc.text).toContain('serve il permesso di posizione');
    const ok = await skill.run(
      { op: 'name_here', label: 'Palestra' },
      {
        ...ctx,
        device: { location: { latitude: 45.4, longitude: 12.3, accuracyM: 23, place: 'Venezia' } },
      },
    );
    expect(here).toMatchObject({ label: 'Palestra', lat: 45.4 });
    expect(ok.text).toContain(
      '📍 Fatto: ho chiamato «palestra» il posto dove sei adesso, a Venezia (precisione circa 25 m).',
    );
    expect(ok.text).toContain('«ricordami di … quando arrivo in palestra»');

    const renamed = await skill.run(
      { op: 'rename_place', from: 'dentista', to: 'Studio Rossi' },
      ctx,
    );
    expect(renamed.text).toBe(
      '📍 Fatto: «dentista» ora si chiama «studio rossi». Ho aggiornato anche i 2 promemoria legati a quel luogo.',
    );
    const missing = await skill.run({ op: 'rename_place', from: 'piscina', to: 'mare' }, ctx);
    expect(missing.text).toContain('Non trovo un luogo chiamato «piscina»');
  });
});

describe('«ricordagli» e «domattina» (segnalati il 15 ott 2026)', () => {
  it('«ricordagli …» non diventa un promemoria per l’utente: lo gestisce il modello con il contesto', () => {
    expect(
      parseReminderCommand(
        'Allora ricordagli fra cinque minuti di venire di là per giocare con noi.',
        NOW,
        TZ,
      ),
    ).toBeNull();
    expect(parseReminderCommand('ricordale domani alle 8 la merenda', NOW, TZ)).toBeNull();
    expect(parseReminderCommand('digli tra 10 minuti di scendere', NOW, TZ)).toBeNull();
    // Quelli con il nome restano della skill.
    expect(
      parseReminderCommand('ricorda a Giorgio tra 5 minuti di venire a giocare', NOW, TZ),
    ).toMatchObject({
      op: 'create',
      who: 'Giorgio',
    });
    expect(
      parseReminderCommand('ricordami tra 5 minuti di chiamare Giorgio', NOW, TZ),
    ).toMatchObject({
      op: 'create',
    });
  });

  it('«domattina alle 6:45» è domani alle 6:45, senza «domattina» nel testo', () => {
    const p = parseReminderCommand('Ricorda a Giorgio di svegliarsi alle 6:45 domattina.', NOW, TZ);
    if (p?.op !== 'create') throw new Error('atteso create');
    expect(p.text).toBe('svegliarsi');
    expect(p.who).toBe('Giorgio');
    const lp = localParts(p.at, TZ);
    expect([lp.day, lp.hour, lp.minute]).toEqual([12, 6, 45]);
    expect(p.assumed).toEqual([]);
    const q = parseReminderCommand('ricordami domattina di comprare il pane', NOW, TZ);
    if (q?.op !== 'create') throw new Error('atteso create');
    expect(localParts(q.at, TZ).hour).toBe(9);
  });
});

describe('descrizione del piano per il controllo di Jev', () => {
  it('chi, cosa, quando, preavviso; niente per elenchi e domande', async () => {
    const { describeReminderPlan } = await import('./reminder.js');
    const p = parseReminderCommand(
      'Ricordami domani di uscire alle 17:00 per andare a prendere il treno. ricordamelo 10 minuti prima.',
      NOW,
      TZ,
    );
    expect(describeReminderPlan(p as never, TZ, NOW)).toBe(
      'promemoria «uscire per andare a prendere il treno» per l’utente domani alle 16:50, preavviso di un appuntamento domani alle 17:00',
    );
    expect(describeReminderPlan({ op: 'list' }, TZ, NOW)).toBeNull();
    const other = parseReminderCommand('ricorda a Giorgio di chiamarmi domani alle 17', NOW, TZ);
    expect(describeReminderPlan(other as never, TZ, NOW)).toMatch(
      /^promemoria «.+» per Giorgio domani alle 17:00$/,
    );
  });
});

describe('date e ore come si dicono (revisione del 16 ott 2026)', () => {
  // NOW = domenica 11 ottobre 2026, 15:00 a Roma.
  const at = (t: string) => {
    const p = parseReminderCommand(t, NOW, TZ);
    return p?.op === 'create' ? `${local(p.at)} | ${p.text}` : (p?.op ?? null);
  };

  it('ore senza mattina o pomeriggio: il pomeriggio se il mattino è passato', () => {
    expect(at('ricordami alle 4 di prendere Giorgio')).toBe('2026-10-11 16:00 | prendere Giorgio');
    expect(at("ricordami all'una di mangiare")).toBe('2026-10-12 13:00 | mangiare');
    expect(at('ricordami alle 8 di uscire')).toBe('2026-10-12 08:00 | uscire');
    expect(at('ricordami domani alle 3 di chiamare Luca')).toBe('2026-10-12 15:00 | chiamare Luca');
  });

  it('relativi: mezz’ora, quarto d’ora, un’ora e mezza, ore e minuti, «min»', () => {
    expect(at("tra mezz'ora ricordami di spegnere il forno")).toBe(
      '2026-10-11 15:30 | spegnere il forno',
    );
    expect(at("fra un quarto d'ora ricordami di uscire")).toBe('2026-10-11 15:15 | uscire');
    expect(at("tra un'ora e mezza ricordami di uscire")).toBe('2026-10-11 16:30 | uscire');
    expect(at('tra 2 ore e 30 minuti ricordami di chiamare')).toBe('2026-10-11 17:30 | chiamare');
    expect(at('tra 10 min ricordami di girare la pasta')).toBe(
      '2026-10-11 15:10 | girare la pasta',
    );
  });

  it('giorni sul calendario: con l’ora detta, o la stessa ora anche dopo il cambio dell’ora', () => {
    expect(at('tra 2 giorni alle 18 ricordami di chiamare la banca')).toBe(
      '2026-10-13 18:00 | chiamare la banca',
    );
    expect(at('tra dieci giorni ricordami di pagare')).toBe('2026-10-21 15:00 | pagare');
    expect(at('tra venti giorni ricordami di pagare')).toBe('2026-10-31 15:00 | pagare');
    expect(at('tra un mese ricordami di rinnovare')).toBe('2026-11-11 15:00 | rinnovare');
  });

  it('minuti e «meno», giorni senza accento, solo il giorno del mese, date impossibili', () => {
    expect(at('ricordami alle 18 e 30 di chiamare il capo')).toBe(
      '2026-10-11 18:30 | chiamare il capo',
    );
    expect(at('ricordami alle diciotto e trenta di chiamare il capo')).toBe(
      '2026-10-11 18:30 | chiamare il capo',
    );
    expect(at('ricordami alle 6 meno un quarto di uscire')).toBe('2026-10-11 17:45 | uscire');
    expect(at('ricordami lunedi alle 8 di portare la macchina')).toBe(
      '2026-10-12 08:00 | portare la macchina',
    );
    expect(at('ricordami il 23 alle 10 di rinnovare il passaporto')).toBe(
      '2026-10-23 10:00 | rinnovare il passaporto',
    );
    expect(at('ricordami il 31 novembre di pagare')).toBeNull();
  });

  it('notte e mattina', () => {
    expect(at('ricordami stanotte alle 2 di controllare il forno')).toBe(
      '2026-10-12 02:00 | controllare il forno',
    );
    expect(at('ricordami alle 2 di notte di controllare il forno')).toBe(
      '2026-10-12 02:00 | controllare il forno',
    );
    expect(at('ricordami alle 11 di notte di chiudere il gas')).toBe(
      '2026-10-11 23:00 | chiudere il gas',
    );
    expect(at('ricordami alle 8 del mattino di fare colazione')).toBe(
      '2026-10-12 08:00 | fare colazione',
    );
  });
});

describe('frasi ambigue fra skill (revisione del 16 ott 2026)', () => {
  it('due promemoria non diventano un appuntamento; alla mamma; ricordati che', () => {
    const p = parseReminderCommand(
      'ricordami alle 18 di chiamare Luca e alle 19 di uscire',
      NOW,
      TZ,
    );
    expect(p).not.toHaveProperty('eventAt');
    expect(
      parseReminderCommand('ricorda alla mamma di chiamarmi domani alle 17', NOW, TZ),
    ).toMatchObject({
      op: 'create',
      who: 'mamma',
      text: 'chiamarmi',
    });
    expect(parseReminderCommand('ricordati che sono allergico alle noci', NOW, TZ)).toBeNull();
    // Il preavviso relativo dopo «ricordami» resta valido.
    expect(
      parseReminderCommand('ricordami alle 18 di chiamare Luca, avvisami 5 minuti prima', NOW, TZ),
    ).toHaveProperty('eventAt');
  });
});
