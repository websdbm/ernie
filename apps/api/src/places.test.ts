import { describe, expect, it } from 'vitest';
import { addressIn, pickBrainPlace, placeFromNote } from './places.js';

const note = (over: Partial<Parameters<typeof placeFromNote>[0]>) => ({
  path: 'Luoghi/X.md',
  title: 'X',
  place: null,
  coords: null,
  excerpt: '',
  ...over,
});

describe('luoghi dal second brain', () => {
  it('trova l’indirizzo nel frontmatter o nel testo', () => {
    expect(addressIn('Lo studio è in via Roma 3, Treviso. Orari 9-18')).toBe('via Roma 3, Treviso');
    expect(addressIn('Piazza Duomo 1, 20121 Milano')).toBe('Piazza Duomo 1, 20121 Milano');
    expect(addressIn('Nessun indirizzo qui')).toBeUndefined();
    expect(placeFromNote(note({ title: 'Palestra', coords: [45.6, 12.2] }))).toEqual({
      title: 'Palestra',
      lat: 45.6,
      lng: 12.2,
    });
    expect(placeFromNote(note({ title: 'Niente' }))).toBeNull();
  });

  it('sceglie la nota giusta per l’etichetta detta', () => {
    const hits = [
      note({ title: 'Cena di Natale', excerpt: 'in via Verdi 2, Treviso' }),
      note({ title: 'Studio dentistico Rossi', excerpt: 'Dott. Rossi, corso Italia 10, Roma.' }),
    ];
    expect(pickBrainPlace(hits, 'dentista')).toEqual({
      title: 'Studio dentistico Rossi',
      address: 'corso Italia 10, Roma',
    });
    expect(pickBrainPlace(hits, 'palestra')).toBeNull();
  });
});
