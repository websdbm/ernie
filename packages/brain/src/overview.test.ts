import { describe, expect, it } from 'vitest';
import { type BrainNote, parseNote, serializeNote } from './note.js';
import { buildBrainOverview } from './overview.js';

const person: BrainNote = {
  path: 'Persone/Anna Rossi.md',
  title: 'Anna Rossi',
  type: 'persona',
  created: '2026-10-13',
  links: [],
  private: false,
  body: '',
};
const home: BrainNote = {
  ...person,
  path: 'Luoghi/Casa dei genitori di Anna.md',
  title: 'Casa dei genitori di Anna',
  type: 'luogo',
  coords: [45.123456789123, 13.123456789123],
  body: 'Uno dei luoghi della tua scheda anagrafica (vedi [[Chi sono]]).',
};

describe('riepilogo di lettura del Second Brain', () => {
  it('raccoglie profilo e storia, deduplica lo stesso campo e mette il GPS in evidenza senza inventare indirizzi', () => {
    const body = `# Anna Rossi

<!-- ernie:family-profile hash -->
Compagna (vedi [[Chi sono]]).

Nascita: 1980-07-08.

porta il 39 di scarpe
<!-- /ernie:family-profile -->

### 17 ottobre 2026

- Numero di scarpe: 39

### 17 ottobre 2026

- I genitori di Anna vivono a [[Trieste]].

## Anna (17 ottobre 2026)

porta il 39 di scarpe

## Informazioni collegate

### [[Luoghi/Casa dei genitori di Anna.md|Casa dei genitori di Anna]] · 2026-10-17

> Uno dei luoghi della tua scheda anagrafica (vedi [[Chi sono]]).
`;
    const n = {
      ...person,
      body,
      extra: ['ernie_unioni: [{"title":"Anna","path":"Persone/Anna.md"}]'],
    };
    const snapshot = serializeNote(n);
    const result = buildBrainOverview(n, [home, home]);
    expect(result?.facts.map((f) => f.text)).toEqual([
      'Compagna (vedi [[Chi sono]]).',
      'Nascita: 1980-07-08.',
      'Numero di scarpe: 39',
      'I genitori di Anna vivono a [[Trieste]].',
    ]);
    expect(result?.facts[3]).toMatchObject({ sourcePath: person.path, date: '17 ottobre 2026' });
    expect(result?.places).toEqual([
      { path: home.path, title: home.title, address: null, coords: home.coords },
    ]);
    expect(serializeNote(n)).toBe(snapshot);
  });
  it('non sceglie arbitrariamente tra valori diversi e conserva il contesto delle sezioni', () => {
    const result = buildBrainOverview(
      {
        ...person,
        body: '## Preferenze\n\nNon mangia carne.\n\n### 2026-10-12\n\n- Numero di scarpe: 38\n\n### 2026-10-17\n\n- Numero di scarpe: 39',
      },
      [],
    );
    expect(result?.facts.map((f) => [f.text, f.date])).toEqual([
      ['**Preferenze**\nNon mangia carne.', null],
      ['Numero di scarpe: 38', '2026-10-12'],
      ['Numero di scarpe: 39', '2026-10-17'],
    ]);
  });
  it('tiene citazioni e provenienza, senza mischiare informazioni di altri luoghi', () => {
    const n = {
      ...person,
      body: '## Informazioni collegate\n\n### [[Note/Viaggio.md|Viaggio]] · 2026-10-17\n\n> Anna ha visitato Torino.',
    };
    expect(buildBrainOverview(n, [])?.facts).toEqual([
      {
        text: 'Anna ha visitato Torino.',
        sourcePath: 'Note/Viaggio.md',
        sourceTitle: 'Viaggio',
        date: '2026-10-17',
      },
    ]);
    expect(buildBrainOverview(n, [{ ...home, private: true }])?.places).toEqual([]);
  });
  it('mostra il luogo stesso e conserva piena precisione GPS nel round trip', () => {
    expect(parseNote(home.path, serializeNote(home)).coords).toEqual(home.coords);
    const r = buildBrainOverview(home, []);
    expect(r?.places[0]?.coords).toEqual(home.coords);
    expect(r?.facts).toEqual([]);
  });
  it('lascia documenti complessi nel renderer originale e non interpreta codice come date', () => {
    expect(buildBrainOverview({ ...person, type: 'documento' }, [])).toBeNull();
    const r = buildBrainOverview({ ...person, body: '```md\n### 2026-10-17\n- esempio\n```' }, []);
    expect(r?.facts[0]?.text).toBe('```md\n### 2026-10-17\n- esempio\n```');
    expect(r?.facts[0]?.date).toBeNull();
  });
});
