import { describe, expect, it } from 'vitest';
import { lexiconNote, STYLE_PROFILES, styleNote, styleOf } from './styles.js';

describe('stili di conversazione', () => {
  it('i profili scelti dall’utente, Neutro predefinito anche per valori sconosciuti', () => {
    expect(STYLE_PROFILES.map((s) => s.id)).toEqual([
      'neutro',
      'scherzoso',
      'essenziale',
      'antico',
    ]);
    expect(styleOf({}).id).toBe('neutro');
    expect(styleOf({ conversationStyle: 'formale' }).id).toBe('neutro');
    expect(styleOf({ conversationStyle: 'antico' }).id).toBe('antico');
  });

  it('nota di stile vuota per Neutro, con il divieto di volgarità per gli altri', () => {
    expect(styleNote({ conversationStyle: 'neutro' })).toBe('');
    expect(styleNote(null)).toBe('');
    const antico = styleNote({ conversationStyle: 'antico' });
    expect(antico).toContain('vossignoria');
    expect(antico).toContain('mai parolacce');
  });

  it('nota del lessico: vuota senza parole, al massimo 20, con il significato', () => {
    expect(lexiconNote('', [])).toBe('');
    const note = lexiconNote('', [
      { term: 'ci sta', meaning: 'va bene' },
      { term: 'bro', meaning: '' },
    ]);
    expect(note).toContain("Parole dell'utente");
    expect(note).toContain('«ci sta» (va bene)');
    expect(note).toContain('«bro»');
    const many = Array.from({ length: 30 }, (_, i) => ({ term: `t${i}`, meaning: '' }));
    expect(lexiconNote('Giorgio', many)).toContain('Parole di Giorgio');
    expect(lexiconNote('', many)).not.toContain('«t20»');
  });
});
