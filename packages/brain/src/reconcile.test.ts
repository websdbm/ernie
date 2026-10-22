import { describe, expect, it } from 'vitest';
import { type BrainNote, parseNote } from './note.js';
import { managedContent, reconcileNotes, reviewFingerprint, reviewNotes } from './reconcile.js';

const person: BrainNote = {
  path: 'Persone/Anna Rossi.md',
  title: 'Anna Rossi',
  type: 'persona',
  created: '2026-10-17T10:00:00Z',
  links: [],
  private: false,
  body: '# Anna Rossi\n\nCompagna. Testo personale.',
};
const place: BrainNote = {
  ...person,
  path: 'Luoghi/Casa Anna Rossi.md',
  title: 'Casa Anna Rossi',
  type: 'luogo',
  place: 'Via Roma 12',
  body: '# Casa Anna Rossi\n\nIndirizzo: Via Roma 12.',
};
const apply = (notes: BrainNote[], files: ReturnType<typeof reconcileNotes>['files']) =>
  notes.map((n) => {
    const f = files.find((f) => f.path === n.path);
    return f ? parseNote(f.path, f.content) : n;
  });
describe('consolidamento del Second Brain', () => {
  it('consolida solo la nuova area e conserva citazioni semantiche già presenti anche nella stessa scheda', () => {
    const oldSource = { ...place, path: 'Luoghi/Vecchia fonte.md', title: 'Vecchia fonte' };
    const other = { ...person, path: 'Persone/Luca.md', title: 'Luca' };
    const otherSource = { ...place, path: 'Luoghi/Altrove.md', title: 'Altrove' };
    const notes = [person, oldSource, other, otherSource];
    const initial = reconcileNotes(notes, {
      connections: [
        { source: oldSource.path, target: person.path, quote: 'Indirizzo: Via Roma 12.' },
        { source: otherSource.path, target: other.path, quote: 'Indirizzo: Via Roma 12.' },
      ],
      questions: [],
    });
    const current = [...apply(notes, initial.files), place];
    const out = reconcileNotes(current, undefined, new Set([place.path]));
    expect(out.files.map((f) => f.path)).toEqual([person.path]);
    expect(out.files[0]?.content).toContain('Vecchia fonte.md');
    expect(out.files[0]?.content).toContain('Casa Anna Rossi.md');
    expect(
      reconcileNotes(apply(current, out.files), undefined, new Set([place.path])).files,
    ).toEqual([]);
    // Una nuova fonte resa privata deve sparire anche dalle citazioni locali.
    const privateNotes = apply(current, out.files).map((n) =>
      n.path === place.path ? { ...n, private: true } : n,
    );
    const cleaned = reconcileNotes(privateNotes, undefined, new Set([place.path]));
    expect(cleaned.files).toHaveLength(1);
    expect(cleaned.files[0]?.content).not.toContain('Casa Anna Rossi.md');
    expect(cleaned.files[0]?.content).toContain('Vecchia fonte.md');
  });

  it('sostituisce una citazione ampliata senza conservare una copia più corta', () => {
    const notes = apply([person, place], reconcileNotes([person, place]).files);
    const changed = notes.map((n) =>
      n.path === place.path ? { ...n, body: `${n.body} Interno 4.` } : n,
    );
    const out = reconcileNotes(changed, undefined, new Set([place.path]));
    expect(out.files).toHaveLength(1);
    expect(out.files[0]?.content.match(/> Indirizzo:/gu)).toHaveLength(1);
    expect(out.files[0]?.content).toContain('Interno 4.');
  });

  it('la passata locale rispetta i dubbi esistenti senza aggiungere associazioni', () => {
    const result = reconcileNotes(
      [person, place],
      {
        connections: [],
        questions: [{ target: person.path, sources: [place.path], question: 'Stessa persona?' }],
      },
      new Set([place.path]),
    );
    expect(result.files).toEqual([]);
  });

  it('ricollega luoghi con il nome breve solo quando l’unione è registrata e non ambigua', () => {
    const canonical = {
      ...person,
      extra: ['ernie_unioni: [{"title":"Anna","path":"Persone/Anna.md"}]'],
    };
    const home = { ...place, title: 'Casa di Anna', path: 'Luoghi/Casa di Anna.md' };
    const out = reconcileNotes([canonical, home]);
    expect(out.connections).toBe(1);
    expect(out.files[0]?.content).toContain('Indirizzo: Via Roma 12.');
    const other = { ...person, title: 'Anna', path: 'Persone/Altra Anna.md' };
    expect(reconcileNotes([canonical, other, home]).connections).toBe(0);
  });

  it('collega luogo e persona conservando originali, testo personale e metadati; è idempotente', () => {
    const notes = [{ ...person, extra: ['preferenza: montagna'] }, place];
    const first = reconcileNotes(notes);
    expect(first.files).toHaveLength(1);
    expect(first.files[0]?.path).toBe(person.path);
    expect(first.files[0]?.content).toContain('[[Luoghi/Casa Anna Rossi.md|Casa Anna Rossi]]');
    expect(first.files[0]?.content).toContain('> Indirizzo: Via Roma 12.');
    expect(first.files[0]?.content).toContain('Testo personale.');
    expect(first.files[0]?.content).toContain('preferenza: montagna');
    const updated = apply(notes, first.files);
    expect(reconcileNotes(updated).files).toEqual([]);
    expect(reviewFingerprint(updated)).toBe(reviewFingerprint(notes));
    expect(reviewNotes(updated)[0]?.body).toBe(person.body);
  });
  it('accetta solo citazioni esatte di fonti esistenti, mai il testo inventato dal modello', () => {
    const alias = { ...place, title: 'Casa della compagna', path: 'Luoghi/Casa della compagna.md' };
    expect(reconcileNotes([person, alias]).files).toEqual([]);
    const plan = {
      connections: [
        { source: alias.path, target: person.path, quote: 'Indirizzo: Via Roma 12.' },
        { source: alias.path, target: person.path, quote: 'Anna vive in Via Milano 99.' },
        { source: 'inesistente.md', target: person.path, quote: 'Fatto falso.' },
      ],
      questions: [],
    };
    const out = reconcileNotes([person, alias], plan);
    expect(out.connections).toBe(1);
    expect(out.files[0]?.content).not.toContain('Milano');
  });
  it('non legge né travasa note riservate, salute o Chi sono, anche se il modello le cita', () => {
    for (const blocked of [
      { ...place, private: true },
      { ...place, type: 'salute' as const },
      { ...place, type: 'chi-sono' as const },
    ]) {
      expect(reviewNotes([blocked])).toEqual([]);
      expect(
        reconcileNotes([person, blocked], {
          connections: [
            { source: blocked.path, target: person.path, quote: 'Indirizzo: Via Roma 12.' },
          ],
          questions: [],
        }).files,
      ).toEqual([]);
    }
    expect(reconcileNotes([{ ...person, private: true }, place]).files).toEqual([]);
  });
  it('rimuove una citazione generata se la fonte viene resa riservata', () => {
    const updated = apply([person, place], reconcileNotes([person, place]).files);
    const out = reconcileNotes(
      updated.map((n) => (n.path === place.path ? { ...n, private: true } : n)),
    );
    expect(out.files).toHaveLength(1);
    expect(out.files[0]?.content).not.toContain('Via Roma');
    expect(out.files[0]?.content).toContain('Testo personale');
  });
  it('non sovrascrive una sezione modificata a mano, né la usa per propagare altri dati', () => {
    const updated = apply([person, place], reconcileNotes([person, place]).files);
    const edited = updated.map((n) =>
      n.path === person.path
        ? {
            ...n,
            body: n.body.replace('> Indirizzo: Via Roma 12.', '> Indirizzo verificato a mano.'),
          }
        : n,
    );
    expect(managedContent(edited[0]?.body ?? '').edited).toBe(true);
    expect(reconcileNotes(edited).files).toEqual([]);
    expect(reviewNotes(edited).map((n) => n.path)).not.toContain(person.path);
  });
  it('un dubbio impedisce anche il collegamento automatico; omonimi non vengono risolti dal titolo', () => {
    const result = reconcileNotes([person, place], {
      connections: [],
      questions: [
        {
          target: person.path,
          sources: [place.path],
          question: 'È ancora questo il suo indirizzo?',
        },
      ],
    });
    expect(result.files).toEqual([]);
    expect(result.questions).toEqual(['Su «Anna Rossi»: È ancora questo il suo indirizzo?']);
    expect(
      reconcileNotes([person, { ...person, path: 'Archivio/Anna Rossi.md' }, place]).files,
    ).toEqual([]);
  });
  it('risolve wikilink per percorso e aggiorna la citazione quando cambia l’indirizzo', () => {
    const source = {
      ...place,
      title: 'Casa',
      body: '# Casa\n\nIndirizzo: Via Roma 12.\n\nQui vive [[Persone/Anna Rossi.md|Anna]].',
    };
    const first = reconcileNotes([person, source]);
    const updated = apply([person, source], first.files).map((n) =>
      n.path === source.path ? { ...n, body: n.body.replace('Roma 12', 'Verdi 4') } : n,
    );
    const second = reconcileNotes(updated);
    expect(second.files[0]?.content).toContain('Via Verdi 4');
    expect(second.files[0]?.content).not.toContain('Via Roma 12');
  });
  it('un dubbio inverso blocca nuovi link e conserva quelli esistenti solo con fonte ancora valida', () => {
    const plan = {
      connections: [],
      questions: [{ target: place.path, sources: [person.path], question: 'Quale Anna?' }],
    };
    expect(reconcileNotes([person, place], plan).files).toEqual([]);
    const updated = apply([person, place], reconcileNotes([person, place]).files);
    expect(reconcileNotes(updated, plan).files).toEqual([]);
    expect(reconcileNotes(updated, plan).connections).toBe(1);
    const savedPerson = updated.find((n) => n.path === person.path);
    if (!savedPerson) throw new Error('persona assente');
    for (const source of [
      { ...place, private: true },
      { ...place, body: '# Casa\n\nNuovo indirizzo.' },
    ]) {
      const out = reconcileNotes([savedPerson, source], plan);
      expect(out.files[0]?.content).not.toContain('Via Roma 12');
    }
    expect(reconcileNotes([savedPerson], plan).files[0]?.content).not.toContain('Via Roma 12');
  });
});
