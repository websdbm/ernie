import { describe, expect, it } from 'vitest';
import { cleanExpressions, isVulgar, normalizeTerm } from './lexicon.js';

describe('lessico: normalizzazione e filtri', () => {
  it('normalizza apostrofi, spazi, maiuscole e punteggiatura ai bordi', () => {
    expect(normalizeTerm('  Ci   Sta! ')).toBe('ci sta');
    expect(normalizeTerm('«Un’altra»')).toBe("un'altra");
  });

  it('riconosce parolacce, bestemmie e insulti, lascia lo slang innocuo', () => {
    for (const t of ['che cazzo', 'Minchia', 'vaffanculo', 'stronzata', 'porco dio', 'sei scemo'])
      expect(isVulgar(t), t).toBe(true);
    for (const t of ['ci sta', 'figata', 'bro', 'sbatti', 'top', 'papo', 'cringe'])
      expect(isVulgar(t), t).toBe(false);
  });

  it('scarta volgarità, doppioni e frasi intere; al massimo sei', () => {
    const out = cleanExpressions([
      { term: 'ci sta', meaning: 'va bene' },
      { term: 'Ci sta!', meaning: 'va bene' },
      { term: 'merda', meaning: 'esclamazione' },
      { term: 'questa è una frase intera troppo lunga', meaning: '' },
      ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((term) => ({ term, meaning: null })),
    ]);
    expect(out.map((e) => e.term)).toEqual(['ci sta', 'a1', 'a2', 'a3', 'a4', 'a5']);
  });
});
