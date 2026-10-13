import { describe, expect, it } from 'vitest';
import { deriveTitle } from './repository.js';
import { chunkPages, toDiagram } from './summarize.js';

describe('riassuntore: pezzi di pagine', () => {
  it('raggruppa pagine contigue entro il limite; una pagina lunga fa pezzo da sola', () => {
    const pages = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(25), 'd'.repeat(5), 'e'.repeat(5)];
    const chunks = chunkPages(pages, 20);
    expect(chunks.map((c) => [c.from, c.to])).toEqual([
      [1, 2],
      [3, 3],
      [4, 5],
    ]);
    expect(chunks[0]?.text).toBe(`${'a'.repeat(10)}\n\n${'b'.repeat(10)}`);
    expect(chunkPages([], 20)).toEqual([]);
  });
});

describe('riassuntore: schema piatto → diagramma', () => {
  it('costruisce la mappa dai nodi con padre, limita la profondità a 3 e aggancia gli orfani alla radice', () => {
    const d = toDiagram(
      {
        type: 'mindmap',
        nodes: [
          { id: 'r', parent: null, label: 'Fotosintesi' },
          { id: 'a', parent: 'r', label: 'Fase luminosa' },
          { id: 'a1', parent: 'a', label: 'Fotolisi' },
          { id: 'a11', parent: 'a1', label: 'Ossigeno' },
          { id: 'a111', parent: 'a11', label: 'Troppo profondo' },
          { id: 'x', parent: 'manca', label: 'Orfano' },
        ],
        steps: [],
        links: [],
        events: [],
      },
      'Titolo',
    );
    expect(d.type).toBe('mindmap');
    if (d.type !== 'mindmap') return;
    expect(d.root.label).toBe('Fotosintesi');
    expect(d.root.children?.map((c) => c.label)).toEqual(['Fase luminosa', 'Orfano']);
    const deep = d.root.children?.[0]?.children?.[0]?.children?.[0];
    expect(deep?.label).toBe('Ossigeno');
    expect(deep?.children).toBeUndefined();
  });

  it('il flusso senza collegamenti diventa sequenziale e scarta i collegamenti verso passi inesistenti', () => {
    const d = toDiagram(
      {
        type: 'flow',
        nodes: [],
        steps: [
          { id: 'a', label: 'Impasta' },
          { id: 'b', label: 'Lievita' },
          { id: 'c', label: 'Cuoci' },
        ],
        links: [{ from: 'a', to: 'zzz' }],
        events: [],
      },
      'Pane',
    );
    expect(d.type).toBe('flow');
    if (d.type !== 'flow') return;
    // Il collegamento verso un passo inesistente viene scartato; senza collegamenti validi il flusso è sequenziale.
    expect(d.links).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    const kept = toDiagram(
      {
        type: 'flow',
        nodes: [],
        steps: d.steps,
        links: [{ from: 'a', to: 'c', label: 'salta' }],
        events: [],
      },
      'Pane',
    );
    if (kept.type === 'flow') expect(kept.links).toEqual([{ from: 'a', to: 'c', label: 'salta' }]);
  });

  it('la linea del tempo con un solo evento viene completata', () => {
    const d = toDiagram(
      {
        type: 'timeline',
        nodes: [],
        steps: [],
        links: [],
        events: [{ when: '1861', label: 'Unità' }],
      },
      'Storia',
    );
    expect(d.type === 'timeline' && d.events.length).toBe(2);
  });
});

describe('titolo derivato dal testo', () => {
  it('prende la prima riga significativa, accorciata a 80 caratteri', () => {
    expect(deriveTitle(['\n  \nLa fotosintesi clorofilliana\nsecondo paragrafo'])).toBe(
      'La fotosintesi clorofilliana',
    );
    expect(deriveTitle(['x'.repeat(100)]).length).toBe(78);
    expect(deriveTitle(['Capitolo 1\n\nLa Mesopotamia\n\nLa Mesopotamia è la regione…'])).toBe(
      'La Mesopotamia',
    );
    expect(deriveTitle(['UNITÀ IV\nI Romani'])).toBe('I Romani');
    expect(deriveTitle(['12 34', ''], new Date(2026, 9, 11))).toBe('Documento del 11/10/2026');
  });
});

describe('schema a frecce (outline)', () => {
  it('raggruppa i nodi per sezione, catene e ramificazioni come negli appunti', () => {
    const d = toDiagram(
      {
        type: 'outline',
        nodes: [
          {
            id: 'a',
            parent: null,
            label: 'Verso il 2350 a.C.',
            section: 'Il regno unico di Lugalzaggesi',
          },
          { id: 'b', parent: 'a', label: 'un re, Lugalzaggesi' },
          { id: 'c', parent: 'b', label: 'riuscì a estendere il proprio dominio' },
          { id: 'd', parent: null, label: 'I Sumeri', section: 'La religione' },
          { id: 'e', parent: 'd', label: 'veneravano le forze della natura' },
          { id: 'f', parent: 'd', label: 'compievano riti della fertilità' },
        ],
        steps: [],
        links: [],
        events: [],
      },
      'I Sumeri',
    );
    expect(d.type).toBe('outline');
    if (d.type !== 'outline') return;
    expect(d.sections.map((s) => s.title)).toEqual([
      'Il regno unico di Lugalzaggesi',
      'La religione',
    ]);
    expect(d.sections[0]?.nodes).toEqual([
      {
        label: 'Verso il 2350 a.C.',
        next: [
          {
            label: 'un re, Lugalzaggesi',
            next: [{ label: 'riuscì a estendere il proprio dominio' }],
          },
        ],
      },
    ]);
    expect(d.sections[1]?.nodes[0]?.next?.map((n) => n.label)).toEqual([
      'veneravano le forze della natura',
      'compievano riti della fertilità',
    ]);
  });
});
