import { describe, expect, it } from 'vitest';
import { isExplicitReminderStart, type ResolverChoice, resolveChoice } from './resolver-choice.js';

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
