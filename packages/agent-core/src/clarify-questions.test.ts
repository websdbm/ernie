import { describe, expect, it } from 'vitest';
import { requestResolutionSchema } from './clarify.js';

describe('domanda operativa obbligatoria', () => {
  it('una risposta vuota non è una risoluzione; le opzioni possono usare solo funzioni attive', () => {
    const schema = requestResolutionSchema([{ id: 'todo', description: 'Attività' }]);
    expect(schema.safeParse({ questions: [] }).success).toBe(false);
    const capability = {
      kind: 'capability',
      about: 'programma',
      question: 'Vuoi una scheda attività o solo un consiglio?',
      options: ['todo', 'none'],
    };
    expect(schema.safeParse({ capability, questions: [] }).success).toBe(true);
    expect(
      schema.safeParse({ capability: { ...capability, options: ['todo', 'ssh'] }, questions: [] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        capability: { ...capability, options: ['Attività', 'none'] },
        questions: [],
      }).success,
    ).toBe(false);
  });
});
