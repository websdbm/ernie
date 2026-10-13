import { describe, expect, it } from 'vitest';
import {
  createMemorySkill,
  type MemoryFact,
  type MemoryLookup,
  parseMemoryRequest,
  plausible,
  provenanceLabel,
} from './memory.js';

const fact = (over: Partial<MemoryFact> = {}): MemoryFact => ({
  id: 'm1',
  content: 'Preferisce il tè al caffè la mattina',
  category: 'preference',
  confidence: 0.9,
  createdAt: new Date('2026-10-12T09:00:00Z'),
  seenCount: 1,
  provenance: { source: 'assistant', trust: 0.8, note: 'consolidamento' },
  ...over,
});

function lookup(facts: MemoryFact[]) {
  const forgotten: string[] = [];
  const store: MemoryLookup = {
    search: async () => facts,
    listActiveSemantic: async () => facts,
    forget: async (_u, id) => {
      forgotten.push(id);
      return true;
    },
  };
  return { store, forgotten };
}

const ctx = { userId: 'u', sessionId: null, requestId: 'r' };

describe('ricordi: riconoscimento', () => {
  it('elenco, provenienza, oblio; «perché lo sai?» senza oggetto va al modello', () => {
    expect(parseMemoryRequest('cosa sai di me?')).toEqual({ op: 'list' });
    expect(parseMemoryRequest("Cos'hai imparato su di me")).toEqual({ op: 'list' });
    expect(parseMemoryRequest('perché sai che mi piace il tè?')).toEqual({
      op: 'why',
      what: 'mi piace il tè',
    });
    expect(parseMemoryRequest('come fai a sapere che ho un cane?')).toEqual({
      op: 'why',
      what: 'ho un cane',
    });
    expect(parseMemoryRequest('perché lo sai?')).toBeNull();
    expect(parseMemoryRequest('dimentica che ho un cane')).toEqual({
      op: 'forget',
      what: 'ho un cane',
    });
    expect(parseMemoryRequest('dimentica tutto')).toBeNull();
    // Le domande generali con «perché» non sono della memoria.
    expect(parseMemoryRequest('perché il cielo è blu?')).toBeNull();
    expect(parseMemoryRequest('chi ti ha detto che sono vegetariano?')).toEqual({
      op: 'why',
      what: 'sono vegetariano',
    });
  });

  it('provenienza in parole e controllo di plausibilità', () => {
    expect(provenanceLabel(fact(), 'Europe/Rome')).toBe(
      'da una nostra conversazione del 12 ottobre: me l’avevi detto tu',
    );
    expect(provenanceLabel(fact({ confidence: 0.6, seenCount: 3 }), 'Europe/Rome')).toBe(
      'da una nostra conversazione del 12 ottobre: l’ho dedotto da quello che dicevi; è tornato fuori 3 volte',
    );
    expect(plausible('mi piace il tè la mattina', 'Preferisce il tè al caffè la mattina')).toBe(
      true,
    );
    expect(plausible('ho un cane', 'Preferisce il tè al caffè la mattina')).toBe(false);
  });
});

describe('ricordi: esecuzione', () => {
  it('perché lo sai: ricordo con provenienza; nessun ricordo: lo dice', async () => {
    const { store } = lookup([fact()]);
    const skill = createMemorySkill(store);
    const why = await skill.run({ op: 'why', what: 'preferisco il tè la mattina' }, ctx);
    expect(why.text).toContain('Ricordo che: «Preferisce il tè al caffè la mattina»');
    expect(why.text).toContain('me l’avevi detto tu');
    const none = await skill.run({ op: 'why', what: 'il cielo è blu' }, ctx);
    expect(none.text).toContain('Non ho un ricordo salvato su «il cielo è blu»');
  });

  it('dimentica solo un ricordo plausibile', async () => {
    const { store, forgotten } = lookup([fact()]);
    const skill = createMemorySkill(store);
    const miss = await skill.run({ op: 'forget', what: 'ho un cane' }, ctx);
    expect(miss.text).toContain('non ho cancellato nulla');
    expect(forgotten).toEqual([]);
    const hit = await skill.run({ op: 'forget', what: 'che preferisco il tè la mattina' }, ctx);
    expect(hit.text).toContain('ho dimenticato: «Preferisce il tè al caffè la mattina»');
    expect(forgotten).toEqual(['m1']);
  });

  it('elenco raggruppato per categoria', async () => {
    const { store } = lookup([
      fact(),
      fact({ id: 'm2', content: 'Ha un figlio, Giorgio, di 13 anni', category: 'relationship' }),
    ]);
    const list = await createMemorySkill(store).run({ op: 'list' }, ctx);
    expect(list.text).toContain('Ecco cosa ricordo di te (2)');
    expect(list.text).toContain('**Preferenze**\n- Preferisce il tè');
    expect(list.text).toContain('**Persone**\n- Ha un figlio, Giorgio');
  });
});
