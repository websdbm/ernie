import { describe, expect, it } from 'vitest';
import { entitiesIn, formatTransferProposal, transferCandidate } from './brain-transfer.js';

const facts = [
  'Ha un figlio di nome Giorgio, di 13 anni.',
  'Giorgio gioca a calcio il martedì.',
  'Il compleanno di Giorgio è il 10 febbraio.',
  'Preferisce che Giorgio faccia i compiti prima di cena.',
  'Vive a Padova.',
  'Va a Padova in bici.',
  'Lavora con Laura su un progetto di Ottobre.',
];

describe('travaso dalla memoria', () => {
  it('riconosce i nomi propri a metà frase, non la prima parola né i mesi', () => {
    expect(entitiesIn('Ha un figlio di nome Giorgio, di 13 anni.')).toEqual(['Giorgio']);
    expect(entitiesIn('Lavora con Laura su un progetto di Ottobre.')).toEqual(['Laura']);
    expect(entitiesIn('Giorgio gioca a calcio.', ['Giorgio'])).toEqual(['Giorgio']);
  });

  it('propone l’argomento con più ricordi e senza pagina; rispetta pagine esistenti e rifiuti', () => {
    expect(transferCandidate(facts, [], ['Giorgio'])).toMatchObject({ entity: 'Giorgio' });
    expect(transferCandidate(facts, ['giorgio'], ['Giorgio'])).toBeNull();
    expect(transferCandidate(facts, [], [], { skip: new Set(['giorgio']) })).toBeNull();
    expect(transferCandidate(facts, [], [], { minFacts: 2 })?.entity).toBe('Giorgio');
    const text = formatTransferProposal({ entity: 'Giorgio', facts: facts.slice(0, 4) });
    expect(text).toContain('ce ne sono 4 su «Giorgio»');
    expect(text).toContain('- Giorgio gioca a calcio il martedì.');
  });
});
