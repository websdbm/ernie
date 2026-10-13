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
    expect(done('ahahah che ridere')).toBe('playful');
    expect(done('grazie mille!')).toBe('happy');
    expect(done('wow, davvero?')).toBe('surprised');
  });

  it('tono della risposta e azioni riuscite', () => {
    expect(done('aggiungi il latte', 'Ho aggiunto il latte alla lista «Spesa».')).toBe('happy');
    expect(done('aggiungi il latte', 'Ok', ['add:latte'])).toBe('happy');
    expect(done('cerca un volo', 'Mi dispiace, non posso prenotare voli.')).toBe('sad');
    // Nel dubbio: neutro (nessun evento).
    expect(done('che ore sono?', 'Sono le 10:30.')).toBeNull();
    expect(done('raccontami dei Sumeri', 'I Sumeri vivevano in Mesopotamia.')).toBeNull();
  });
});
