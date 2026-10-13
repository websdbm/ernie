import { describe, expect, it } from 'vitest';
import { bodyLinks, isoDay, parseNote, pathFor, safeFileName, serializeNote } from './note.js';

describe('note del second brain', () => {
  it('legge frontmatter in stile Obsidian, collegamenti nel testo e chiavi sconosciute', () => {
    const text = [
      '---',
      'tipo: nota',
      'creata: 2026-10-13T14:05',
      'riguarda: 2026-10-14',
      'luogo: Padova',
      'coordinate: [45.4064, 11.8768]',
      'collegamenti:',
      '  - "[[Giorgio]]"',
      'tags: [scuola, gita]',
      'aliases:',
      '  - Gita',
      'riservata: false',
      'fonte: voce',
      '---',
      '',
      'Portare il modulo firmato per la gita con [[Scuola|la scuola]] e [[Museo#orari]].',
    ].join('\n');
    const n = parseNote('Note/Gita.md', text);
    expect(n).toMatchObject({
      title: 'Gita',
      type: 'nota',
      refersFrom: '2026-10-14',
      place: 'Padova',
      coords: [45.4064, 11.8768],
      private: false,
      source: 'voce',
    });
    expect(n.links).toEqual(['Giorgio', 'Scuola', 'Museo']);
    expect(n.extra).toEqual(['tags: [scuola, gita]', 'aliases:', '  - Gita']);
    // Riscrittura: le chiavi sconosciute di Obsidian restano, il testo pure.
    const again = parseNote('Note/Gita.md', serializeNote(n));
    expect(again).toEqual(n);
  });

  it('nota senza frontmatter, nomi di file sicuri, date valide', () => {
    const n = parseNote(
      'Idee/Una cosa.md',
      'Solo testo con [[Laura]]',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(n).toMatchObject({
      title: 'Una cosa',
      type: 'nota',
      links: ['Laura'],
      created: '2026-01-01T00:00:00.000Z',
    });
    expect(safeFileName('Codice: caldaia / «4471»?')).toBe('Codice caldaia «4471»');
    expect(pathFor('persona', 'Giorgio')).toBe('Persone/Giorgio.md');
    expect(pathFor('chi-sono', 'x')).toBe('Chi sono.md');
    expect(isoDay('2026-02-30')).toBeUndefined();
    expect(isoDay('2026-10-14')).toBe('2026-10-14');
    expect(bodyLinks('[[A]] [[A]] [[B|b]]')).toEqual(['A', 'B']);
  });
});
