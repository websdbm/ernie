import { describe, expect, it } from 'vitest';
import {
  isExplicitReminderStart,
  isFollowupAnswer,
  lastAssistantQuestion,
  type ResolverChoice,
  resolveChoice,
} from './resolver-choice.js';

const choice = (): ResolverChoice => ({
  message: 'Passare in laboratorio alle 19:30',
  question: 'Che risultato vuoi?',
  kind: 'capability',
  options: [
    { label: 'Imposta un promemoria', value: 'ricordami' },
    { label: 'Solo un consiglio', value: 'none' },
  ],
  createdAt: Date.now(),
});
describe('continuazione delle domande del resolver', () => {
  it('riconosce la domanda conclusiva anche dopo un impegno già completato', () => {
    const question = 'Vuoi che imposti l’avviso per il viaggio alle 7:20 di domani?';
    const message = `La call è già stata corretta. ${'Dettagli della call. '.repeat(20)}\n\n${question}`;
    expect(lastAssistantQuestion(message)).toBe(question);
    expect(lastAssistantQuestion('Mi hai chiesto «Che ora è?» e ti ho già risposto.')).toBeNull();
    const p: ResolverChoice = {
      message,
      question,
      kind: 'followup',
      options: [],
      createdAt: Date.now(),
    };
    expect(resolveChoice(p, 'Sì')?.note).toContain(`domanda rimasta aperta: «${question}»`);
    expect(resolveChoice(p, 'Crea una lista per domani')).toBeUndefined();
    expect(resolveChoice({ ...p, createdAt: Date.now() - 601000 }, 'Sì')).toBeUndefined();
  });
  it('lega un orario alla domanda temporale e mantiene indipendenti le richieste nuove', () => {
    expect(isFollowupAnswer('Giovedì alle 7:20', 'Quando vuoi l’avviso?')).toBe(true);
    expect(
      isFollowupAnswer('Giovedì alle 7:20 ricordami il veterinario', 'Quando vuoi l’avviso?'),
    ).toBe(false);
    expect(isFollowupAnswer('7:20', 'Chi è Luca?')).toBe(false);
  });
  it('conserva richiesta e scelta e non interpreta una scelta come nuova richiesta', () => {
    expect(resolveChoice(choice(), 'Imposta un promemoria')).toMatchObject({
      message: 'Passare in laboratorio alle 19:30',
      skillId: 'ricordami',
    });
    expect(resolveChoice(choice(), 'Solo un consiglio')?.skillId).toBeNull();
  });
  it('non assume risposte ambigue, scadute o non corrispondenti', () => {
    expect(resolveChoice(choice(), 'Sì')).toBeUndefined();
    expect(resolveChoice(choice(), 'Che tempo fa?')).toBeUndefined();
    expect(
      resolveChoice({ ...choice(), createdAt: Date.now() - 601000 }, 'Imposta un promemoria'),
    ).toBeUndefined();
    const p = choice();
    p.options = [
      { label: 'Imposta un promemoria', value: 'ricordami' },
      { label: 'Imposta un promemoria', value: 'todo' },
    ];
    expect(resolveChoice(p, 'Imposta un promemoria')).toBeUndefined();
  });
  it('la scelta semantica non cambia funzione e la correzione resta contestuale', () => {
    const p = { ...choice(), kind: 'meaning' as const };
    expect(resolveChoice(p, 'Imposta un promemoria')).not.toHaveProperty('skillId');
  });
  it('riconosce soltanto comandi espliciti vuoti; non forza negazioni o domande informative', () => {
    for (const t of ['Imposta un promemoria', 'creami un promemoria', 'Ricordami'])
      expect(isExplicitReminderStart(t)).toBe(true);
    for (const t of [
      'Non impostare un promemoria',
      'Come si imposta un promemoria?',
      'Imposta un promemoria quando parliamo di scuola',
      'Imposta un promemoria e una lista',
    ])
      expect(isExplicitReminderStart(t)).toBe(false);
  });
});
