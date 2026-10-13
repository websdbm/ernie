import { describe, expect, it } from 'vitest';
import {
  createIntentSkill,
  formatFiredIntents,
  type IntentStore,
  parseIntentCommand,
} from './intents.js';

describe('promemoria a evento: riconoscimento', () => {
  it('le forme comuni, anche per un familiare; il resto non è suo', () => {
    expect(
      parseIntentCommand('Quando si parla della gita, ricordami il modulo da firmare'),
    ).toEqual({
      op: 'create',
      trigger: 'gita',
      reminder: 'il modulo da firmare',
    });
    expect(
      parseIntentCommand('ricordami di comprare le pile quando parliamo del telecomando'),
    ).toEqual({
      op: 'create',
      trigger: 'telecomando',
      reminder: 'comprare le pile',
    });
    expect(
      parseIntentCommand('ogni volta che nomino la palestra ricordami che devo pagare la quota'),
    ).toMatchObject({
      trigger: 'palestra',
      reminder: 'devo pagare la quota',
    });
    expect(
      parseIntentCommand('quando Giorgio parla della gita, ricordagli di portare il modulo'),
    ).toEqual({
      op: 'create',
      trigger: 'gita',
      reminder: 'portare il modulo',
      who: 'Giorgio',
    });
    expect(parseIntentCommand('che promemoria a evento ho?')).toEqual({ op: 'list' });
    expect(parseIntentCommand('annulla il promemoria sulla gita')).toEqual({
      op: 'cancel',
      what: 'gita',
    });
    expect(parseIntentCommand('ricordami di chiamare il dentista alle 17')).toBeNull();
    expect(parseIntentCommand('quando parte il treno?')).toBeNull();
  });

  it('testo quando scatta e risposta di conferma', async () => {
    expect(
      formatFiredIntents([
        {
          id: '1',
          trigger: 'gita',
          reminder: 'il modulo',
          fires: 1,
          expiresAt: new Date(),
          from: 'papà',
        },
      ]),
    ).toBe('📌 Promemoria da papà (hai parlato di «gita»): il modulo');
    const store: IntentStore = {
      create: async (_u, i) => ({
        id: 'x',
        trigger: i.trigger,
        reminder: i.reminder,
        fires: 0,
        expiresAt: new Date('2027-01-11T10:00:00Z'),
      }),
      list: async () => [],
      cancel: async () => null,
      fire: async () => [],
    };
    const skill = createIntentSkill(store);
    const r = await skill.run(skill.match('quando si parla della gita, ricordami il modulo'), {
      userId: 'u',
      sessionId: null,
      requestId: 'r',
    });
    expect(r.text).toBe(
      '📌 Va bene: quando si parlerà di «gita» ti ricorderò: il modulo. Vale fino all’11 gennaio, al massimo tre volte e non più di una al giorno.',
    );
  });
});
