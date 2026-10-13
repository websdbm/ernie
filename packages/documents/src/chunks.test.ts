import { describe, expect, it } from 'vitest';
import { chunkDocument, isHeading } from './chunks.js';
import { citedPages, verifiedCitations } from './citations.js';

const pages = [
  'Capitolo 2\nLe civiltà mesopotamiche\nI Sumeri si stabilirono tra il Tigri e l’Eufrate verso il 4000 a.C. e fondarono città-stato.',
  'Uruk aveva circa 50.000 abitanti e grandi mura.\nRE-SACERDOTE E ZIQQURAT\nIl governo era teocratico: il re era detto Lugal o Ensi e la ziqqurat era tempio e magazzino.',
  'La ziqqurat ospitava anche la scuola degli scribi, dove si imparava la scrittura cuneiforme.',
];

describe('pezzi dei documenti', () => {
  it('riconosce i titoli e li porta tra le pagine', () => {
    expect(isHeading('Capitolo 2')).toBe(true);
    expect(isHeading('RE-SACERDOTE E ZIQQURAT')).toBe(true);
    expect(isHeading('2.1 La scrittura cuneiforme')).toBe(true);
    expect(isHeading('Il governo era teocratico.')).toBe(false);
    const ch = chunkDocument(pages);
    expect(ch.map((c) => [c.page, c.heading])).toEqual([
      [1, 'Capitolo 2 · Le civiltà mesopotamiche'],
      [2, 'Capitolo 2 · Le civiltà mesopotamiche'],
      [2, 'RE-SACERDOTE E ZIQQURAT'],
      [3, 'RE-SACERDOTE E ZIQQURAT'],
    ]);
    expect(ch.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('pezzi oltre le 220 parole si dividono sulla stessa pagina', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `Frase numero ${i} con alcune parole di riempimento per il test.`,
    ).join('\n');
    const ch = chunkDocument([long]);
    expect(ch.length).toBeGreaterThan(1);
    expect(ch.every((c) => c.page === 1)).toBe(true);
  });
});

describe('citazioni verificate', () => {
  const hits = [
    {
      id: '1',
      documentId: 'd',
      title: 'Storia',
      page: 2,
      heading: 'RE-SACERDOTE E ZIQQURAT',
      content: 'Il re era detto Lugal…',
    },
    {
      id: '2',
      documentId: 'd',
      title: 'Storia',
      page: 3,
      heading: null,
      content: 'Scuola degli scribi…',
    },
  ];
  it('solo le pagine citate e presenti tra i passaggi del turno', () => {
    expect(
      citedPages('Il re era detto Lugal (p. 2); la scuola (pag. 3) e altro (pp. 7-8).'),
    ).toEqual([2, 3, 7, 8]);
    const c = verifiedCitations(
      'Il re era detto Lugal (p. 2), la scuola era nella ziqqurat (p. 3), e una pagina inventata (p. 9).',
      hits,
    );
    expect(c.map((x) => x.page)).toEqual([2, 3]);
    expect(c[0]).toMatchObject({ title: 'Storia', heading: 'RE-SACERDOTE E ZIQQURAT' });
    expect(verifiedCitations('Nessuna citazione qui.', hits)).toEqual([]);
  });
});
