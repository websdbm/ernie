import { describe, expect, it } from 'vitest';
import { inferEmotion } from './emotion.js';

const done = (userText: string, replyText = 'Va bene.', actions?: string[]) =>
  inferEmotion({ userText, replyText, outcome: 'completed', ...(actions ? { actions } : {}) })
    ?.name ?? null;

describe('emozione dell’avatar dal turno', () => {
  it('esito: errore → triste; annullato → nessuna', () => {
    expect(inferEmotion({ userText: 'ciao', replyText: '', outcome: 'error' })?.name).toBe('sad');
    expect(inferEmotion({ userText: 'ciao', replyText: '', outcome: 'cancelled' })).toBeNull();
  });

  it('empatia prima di tutto: lo stato d’animo dell’utente vince sul resto', () => {
    expect(done('oggi sono proprio triste, grazie per ascoltarmi')).toBe('sad');
    expect(done('che brutta giornata')).toBe('sad');
    expect(done('ti voglio bene Ernie')).toBe('love');
    expect(done('ahahah che ridere')).toBe('laughing');
    expect(done('scherzavo, lol')).toBe('playful');
    expect(done('grazie mille!')).toBe('happy');
    expect(done('wow, davvero?')).toBe('surprised');
  });

  it('tono della risposta e azioni riuscite', () => {
    expect(['happy', 'cool', 'proud']).toContain(
      done('aggiungi il latte', 'Ho aggiunto il latte alla lista «Spesa».'),
    );
    expect(['happy', 'cool', 'proud']).toContain(done('aggiungi il latte', 'Ok', ['add:latte']));
    expect(done('cerca un volo', 'Mi dispiace, non posso prenotare voli.')).toBe('sad');
    // Nel dubbio: neutro (nessun evento).
    expect(done('che ore sono?', 'Sono le 10:30.')).toBeNull();
    expect(done('raccontami dei Sumeri', 'I Sumeri vivevano in Mesopotamia.')).toBeNull();
  });
});

describe('espressioni del secondo foglio (occhiali da sole, feroce…)', () => {
  it('occhiali da sole, feroce, fiero, entusiasta, sonno', () => {
    expect(done('sei un mito Ernie 😎')).toBe('cool');
    expect(done('forza Ernie, carica! 💪')).toBe('fierce');
    expect(done('grrr fai il feroce')).toBe('fierce');
    expect(done('bravissimo, ottimo lavoro')).toBe('proud');
    expect(done('evviva, finalmente venerdì 🎉')).toBe('excited');
    expect(done('buonanotte Ernie')).toBe('sleep');
  });

  it('empatia: utente arrabbiato → serio, preoccupato → preoccupato; risposte confuse o con un errore', () => {
    expect(done('sono proprio arrabbiato con il capo')).toBe('determined');
    expect(done('sono preoccupato per l’esame')).toBe('worried');
    expect(done('ho paura del dentista')).toBe('worried');
    expect(done('fai la cosa', 'Non ho capito: intendi la lista o il promemoria?')).toBe(
      'confused',
    );
    expect(done('era alle 9', 'Hai ragione, ho sbagliato: lo sposto alle 9.')).toBe('embarrassed');
  });

  it('lavoro fatto: la stessa risposta dà sempre la stessa espressione', () => {
    const a = done('aggiungi il pane', 'Ho aggiunto il pane alla lista.');
    expect(done('aggiungi il pane', 'Ho aggiunto il pane alla lista.')).toBe(a);
  });
});
