import type { Clarification } from '@ernie/jev-router';
import { describe, expect, it } from 'vitest';
import { interpretationBlock, isCorrection } from './clarify.js';

describe('chiarimento interno (server)', () => {
  it('riconosce le correzioni esplicite, non le richieste nuove', () => {
    for (const t of [
      'no, intendevo domani',
      'No: con «lui» non intendevo Giorgio.',
      'ma no, volevo dire Giorgio',
      'non hai capito',
      'Hai capito male, era venerdì',
      "intendevo l'altro",
      'no ho detto alle 7',
      'guarda che intendevo Fabio',
      'no non era questo',
      '[voce] No, dicevo la palestra',
      'Macché, intendevo sabato',
      'cioè, volevo dire Fabio',
    ])
      expect(isCorrection(t), t).toBe(true);
    for (const t of [
      'no grazie',
      'no',
      'non ho fame',
      'volevo dire a Giorgio che arrivo',
      'intendo andare al mare',
      'scrivi a Giorgio che non era colpa sua',
    ])
      expect(isCorrection(t), t).toBe(false);
  });

  it('la riga «Ho inteso» solo con interpretazioni sicure', () => {
    const base: Clarification = {
      trigger: 'ambiguous',
      questions: [],
      answers: [],
      resolved: [],
      unresolved: [],
      costUsd: 0,
      latencyMs: 1,
    };
    expect(interpretationBlock(base)).toBeNull();
    expect(
      interpretationBlock({
        ...base,
        resolved: [{ about: 'lui', meaning: 'Giorgio', confidence: 0.9 }],
      }),
    ).toEqual({
      kind: 'interpretation',
      trigger: 'ambiguous',
      items: [{ about: 'lui', meaning: 'Giorgio' }],
    });
  });
});
