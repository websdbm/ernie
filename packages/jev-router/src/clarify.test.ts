import { describe, expect, it } from 'vitest';
import {
  type ClarifyInput,
  clarificationNote,
  clarifyQuestions,
  clarifyState,
  createClarifier,
  type Questioner,
} from './clarify.js';
import { createMockJevClient } from './client.js';

const input: ClarifyInput = {
  trigger: 'ambiguous',
  message: 'Vorrei che Jeff desse le risposte e che lui gli facesse le domande',
  inputMode: 'voice',
  recentTurns: ['utente: parliamo del router', 'assistente: il router è Jev'],
  people: ['Giorgio', 'Fabio'],
  places: ['casa', 'lavoro'],
};

const questioner: Questioner = async () => ({
  questions: [
    {
      about: 'Jeff',
      question: 'Chi è «Jeff»?',
      options: ['Jev, il router', 'una persona di nome Jeff'],
    },
    {
      about: 'lui',
      question: 'Chi è «lui»?',
      options: ['il modello che fa le domande', 'Giorgio'],
    },
    // Domanda senza alternative vere: scartata.
    { about: 'x', question: 'Che cosa?', options: ['a', 'A'] },
  ],
  costUsd: 0.0004,
});

describe('chiarimento interno', () => {
  it('domande chiuse per Jev con «non si può dire»; stato con persone, luoghi e dettatura', () => {
    const q = clarifyQuestions([
      { about: 'lui', question: 'Chi è «lui»?', options: ['Giorgio', 'Fabio'] },
    ]);
    expect(q.q1).toEqual({
      type: 'choice',
      instructions: 'Chi è «lui»? (nel messaggio: «lui»)',
      criteria: {
        o1: 'Giorgio',
        o2: 'Fabio',
        non_si_sa: 'Dal messaggio e dal contesto non si può stabilire.',
      },
    });
    const st = clarifyState(input);
    expect(st).toMatchObject({
      known_people: ['Giorgio', 'Fabio'],
      known_places: ['casa', 'lavoro'],
    });
    expect(String(st.note)).toContain('dettato');
  });

  it('le risposte sicure diventano interpretazioni, le incerte restano dubbi', async () => {
    const jev = createMockJevClient(() => ({
      q1: { type: 'choice', choice: 'o1', confidence: 0.93 },
      q2: { type: 'choice', choice: 'o1', confidence: 0.55 },
    }));
    const c = await createClarifier({ jev, questioner, minConfidence: 0.7 }).clarify(input);
    expect(c?.questions).toHaveLength(2);
    expect(c?.resolved).toEqual([{ about: 'Jeff', meaning: 'Jev, il router', confidence: 0.93 }]);
    expect(c?.unresolved.map((q) => q.about)).toEqual(['lui']);
    expect(c?.costUsd).toBeCloseTo(0.0004);
    const note = clarificationNote(c as NonNullable<typeof c>);
    expect(note).toContain('«Jeff» = Jev, il router');
    expect(note).toContain('Dubbi rimasti: Chi è «lui»?');
    expect(note).toContain('present_choices');
  });

  it('«non si può dire» non è un’interpretazione; correzione → nota apposita', async () => {
    const jev = createMockJevClient(() => ({
      q1: { type: 'choice', choice: 'non_si_sa', confidence: 0.99 },
      q2: { type: 'choice', choice: 'o2', confidence: 0.9 },
    }));
    const c = await createClarifier({ jev, questioner, minConfidence: 0.7 }).clarify({
      ...input,
      trigger: 'correction',
    });
    expect(c?.resolved).toEqual([{ about: 'lui', meaning: 'Giorgio', confidence: 0.9 }]);
    expect(c?.unresolved.map((q) => q.about)).toEqual(['Jeff']);
    expect(clarificationNote(c as NonNullable<typeof c>)).toMatch(/^L’utente sta correggendo/);
  });

  it('nessuna domanda o nessun Jev → niente chiarimento; tempo scaduto → errore', async () => {
    const none: Questioner = async () => ({ questions: [], costUsd: 0 });
    expect(
      await createClarifier({
        jev: createMockJevClient(),
        questioner: none,
        minConfidence: 0.7,
      }).clarify(input),
    ).toBeNull();
    expect(
      await createClarifier({ jev: null, questioner, minConfidence: 0.7 }).clarify(input),
    ).toBeNull();
    const slow = createMockJevClient(undefined, { latencyMs: 200 });
    await expect(
      createClarifier({ jev: slow, questioner, minConfidence: 0.7, timeoutMs: 30 }).clarify(input),
    ).rejects.toThrow();
  });
});
