import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BrainHit, BrainIndex, NoteSummary } from './index-store.js';
import type { BrainNote } from './note.js';
import { createBrainService, parseChiSono } from './service.js';

/** Indice in memoria: basta per provare vault e servizio senza Postgres. */
function memoryIndex(): BrainIndex & { notes: Map<string, BrainNote> } {
  const notes = new Map<string, BrainNote>();
  const sum = (n: BrainNote): NoteSummary => ({
    path: n.path,
    title: n.title,
    type: n.type,
    created: n.created,
    refersFrom: n.refersFrom ?? null,
    refersTo: n.refersTo ?? null,
    place: n.place ?? null,
    coords: n.coords ?? null,
    links: n.links,
    private: n.private,
    source: n.source ?? null,
    excerpt: n.body.slice(0, 80),
  });
  return {
    notes,
    async upsert(_u, n) {
      const same = JSON.stringify(notes.get(n.path)) === JSON.stringify(n);
      notes.set(n.path, n);
      return !same;
    },
    async remove(_u, p) {
      notes.delete(p);
    },
    async search(_u, q) {
      const words = (q.query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      return [...notes.values()]
        .filter((n) => q.includePrivate || !n.private)
        .filter((n) => words.some((w) => `${n.title} ${n.body}`.toLowerCase().includes(w)))
        .map((n): BrainHit => ({ ...sum(n), passage: n.body, heading: null, score: 1 }));
    },
    async list(_u, q = {}) {
      return [...notes.values()]
        .filter(
          (n) => !q.linkedTo || n.links.some((l) => l.toLowerCase() === q.linkedTo?.toLowerCase()),
        )
        .filter((n) => !q.type || n.type === q.type)
        .map(sum);
    },
    async get(_u, p) {
      const n = notes.get(p);
      return n ? sum(n) : null;
    },
    async findByTitle(_u, t) {
      const n = [...notes.values()].find(
        (x) => x.title.toLowerCase() === t.toLowerCase() || x.path === t,
      );
      return n ? sum(n) : null;
    },
    async count() {
      return notes.size;
    },
    async suggest() {
      return null;
    },
    async paths() {
      return new Map([...notes.keys()].map((k) => [k, 'h']));
    },
  };
}

const user = '11111111-2222-3333-4444-555555555555';
const tmp = mkdtempSync(join(tmpdir(), 'ernie-brain-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Persona',
      GIT_AUTHOR_EMAIL: 'p@x',
      GIT_COMMITTER_NAME: 'Persona',
      GIT_COMMITTER_EMAIL: 'p@x',
    },
  });

describe('second brain: vault git e servizio', () => {
  it('scrive, aggiunge, collega, legge con i rimandi; sincronizza con un remoto modificato da «Obsidian»', async () => {
    const remote = join(tmp, 'remote.git');
    git(tmp, 'init', '--bare', '-b', 'main', remote);
    const index = memoryIndex();
    const edited: unknown[] = [];
    const brain = createBrainService({
      baseDir: join(tmp, 'vaults'),
      remotes: new Map([[user, remote]]),
      index,
      onChiSonoEdited: async (_u, f) => {
        edited.push(f);
      },
    });

    const first = await brain.write(user, {
      title: 'Codice della caldaia',
      body: 'Il codice di assistenza è 4471. Tecnico: [[Mario Bianchi]].',
      links: ['Casa'],
      place: 'Padova',
      coords: [45.41, 11.88],
      source: 'voce',
      concepts: [{ title: 'Mario Bianchi', type: 'persona' }],
    });
    expect(first).toMatchObject({ path: 'Note/Codice della caldaia.md', created: true });
    expect(first.links).toEqual(['Casa', 'Mario Bianchi']);
    // Pagine-concetto create insieme alla nota, con il tipo indicato o «argomento».
    expect(first.newPages).toEqual(['Casa', 'Mario Bianchi']);
    expect(index.notes.get('Persone/Mario Bianchi.md')?.links).toEqual(['Codice della caldaia']);
    expect(index.notes.get('Argomenti/Casa.md')?.type).toBe('argomento');
    const again = await brain.write(user, {
      title: 'codice della caldaia',
      body: 'Revisione fatta a ottobre.',
    });
    expect(again.created).toBe(false);
    const read = await brain.read(user, 'Codice della caldaia');
    expect(read?.note.body).toContain('4471');
    expect(read?.note.body).toContain('Revisione fatta a ottobre.');
    const casa = await brain.write(user, {
      title: 'Casa',
      type: 'argomento',
      body: 'Tutto sulla casa.',
    });
    expect(casa.created).toBe(false);
    expect((await brain.read(user, 'Casa'))?.backlinks).toEqual(['Codice della caldaia']);

    // Il remoto ha i commit di Ernie.
    const clone = join(tmp, 'obsidian');
    git(tmp, 'clone', remote, clone);
    expect(git(clone, 'log', '--format=%an %s').split('\n')[0]).toBe(
      'Ernie Ernie: aggiunto a «Casa»',
    );

    // «Obsidian»: la persona aggiunge una nota e corregge «Chi sono».
    await brain.writeChiSono(user, {
      fullName: 'Marco Rossi',
      preferredName: 'Marchino',
      family: [{ name: 'Emma', relation: 'figlia' }],
    });
    git(clone, 'pull');
    expect(git(clone, 'show', 'HEAD:Persone/Emma.md')).toContain('Figlia');
    writeFileSync(join(clone, 'Idea dal Mac.md'), 'Scritta in Obsidian, parla di [[Casa]].\n');
    const chi = git(clone, 'show', 'HEAD:Chi sono.md').replace(
      'chiamami: "Marchino"',
      'chiamami: "Marco"',
    );
    writeFileSync(join(clone, 'Chi sono.md'), chi);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'dal Mac');
    git(clone, 'push');

    const sync = await brain.syncAll();
    expect(sync).toEqual([{ userId: user, changed: 2, conflict: false }]);
    expect(index.notes.get('Idea dal Mac.md')?.links).toEqual(['Casa']);
    expect(edited).toMatchObject([{ fullName: 'Marco Rossi', preferredName: 'Marco' }]);
  });

  it('luoghi della scheda: una nota per luogo in Luoghi; il testo aggiunto resta; la rinomina sposta la nota', async () => {
    const index = memoryIndex();
    const brain = createBrainService({ baseDir: join(tmp, 'vaults-luoghi'), index });
    const vault = join(tmp, 'vaults-luoghi', user);
    await brain.writeChiSono(user, {
      fullName: 'Marco Rossi',
      family: [],
      places: [
        { id: 'p1', label: 'casa', address: 'via Barozzi 4, Padova', lat: 45.41, lng: 11.88 },
        { id: 'p2', label: 'lavoro', address: 'via Venezia 1, Padova' },
      ],
    });
    const casa = index.notes.get('Luoghi/Casa.md');
    expect(casa).toMatchObject({
      type: 'luogo',
      place: 'via Barozzi 4, Padova',
      coords: [45.41, 11.88],
    });
    expect(casa?.links).toContain('Chi sono');
    expect(index.notes.get('Luoghi/Lavoro.md')?.place).toBe('via Venezia 1, Padova');
    expect(index.notes.get('Chi sono.md')?.body).toContain(
      '## Luoghi\n\n- [[Casa]]: via Barozzi 4, Padova',
    );

    // In Obsidian la persona collega «Casa» ad altro; poi l'indirizzo cambia nella scheda.
    const raw = git(vault, 'show', 'HEAD:Luoghi/Casa.md');
    writeFileSync(join(vault, 'Luoghi/Casa.md'), `${raw.trimEnd()}\n\nQui abita anche [[Emma]].\n`);
    git(vault, 'add', '-A');
    git(vault, 'commit', '-m', 'dal Mac');
    await brain.writeChiSono(user, {
      fullName: 'Marco Rossi',
      family: [],
      places: [
        { id: 'p1', label: 'casa', address: 'via Roma 3, Padova', lat: 45.4, lng: 11.87 },
        { id: 'p2', label: 'ufficio', address: 'via Venezia 1, Padova' },
      ],
    });
    const after = git(vault, 'show', 'HEAD:Luoghi/Casa.md');
    expect(after).toContain('luogo: via Roma 3, Padova');
    expect(after).toContain('scheda anagrafica (vedi [[Chi sono]]): via Roma 3, Padova.');
    expect(after).not.toContain('Barozzi');
    expect(after).toContain('Qui abita anche [[Emma]].');
    // «lavoro» rinominato «ufficio»: la nota si sposta (stesso id nella scheda), con il titolo nuovo.
    expect(index.notes.has('Luoghi/Lavoro.md')).toBe(false);
    expect(index.notes.get('Luoghi/Ufficio.md')?.body).toMatch(/^# Ufficio/u);
    expect(index.notes.get('Luoghi/Ufficio.md')?.body).toContain('«portami in ufficio»');
    // Nessun cambiamento: nessun commit nuovo.
    const head = git(vault, 'rev-parse', 'HEAD');
    await brain.writeChiSono(user, {
      fullName: 'Marco Rossi',
      family: [],
      places: [
        { id: 'p1', label: 'casa', address: 'via Roma 3, Padova', lat: 45.4, lng: 11.87 },
        { id: 'p2', label: 'ufficio', address: 'via Venezia 1, Padova' },
      ],
    });
    expect(git(vault, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('i campi della scheda tornano da «Chi sono»', () => {
    const fields = parseChiSono({
      path: 'Chi sono.md',
      title: 'Chi sono',
      type: 'chi-sono',
      created: '2026-10-13',
      links: [],
      private: false,
      body: '',
      extra: ['nome: "Marco Rossi"', 'nascita: "1980-04-12"', 'tags: [x]'],
    });
    expect(fields).toMatchObject({ fullName: 'Marco Rossi', birthDate: '1980-04-12', city: null });
  });
});

describe('second brain B3: modifica, cancellazione, riordino', () => {
  it('unisce le note in una pagina, aggiorna chi le citava, modifica e cancella dall’app', async () => {
    const index = memoryIndex();
    const base = join(tmp, 'b3');
    const service = createBrainService({ baseDir: base, index });
    for (const [title, body] of [
      ['Caldaia bloccata', 'La caldaia si è bloccata, errore E2. Vedi [[Caldaia]].'],
      ['Numero del tecnico', 'Il tecnico della [[Caldaia]] è Mario, 333 1234567.'],
      ['Revisione caldaia', 'Revisione della [[Caldaia]] fatta a settembre.'],
    ] as const)
      await service.write(user, {
        title,
        body,
        concepts: [{ title: 'Caldaia', type: 'argomento' }],
      });
    await service.write(user, {
      title: 'Spese di casa',
      body: 'Quest’anno: [[Numero del tecnico]] chiamato due volte, [[Caldaia bloccata]] a gennaio.',
    });
    expect(await service.reorganizeCandidates(user, { minNotes: 3 })).toEqual([
      {
        title: 'Caldaia',
        type: 'argomento',
        notes: ['Caldaia bloccata', 'Numero del tecnico', 'Revisione caldaia'],
      },
    ]);
    expect(await service.reorganizeCandidates(user, { minNotes: 4 })).toEqual([]);

    const merged = await service.merge(user, {
      into: 'Caldaia',
      notes: [
        'Caldaia bloccata',
        'Numero del tecnico',
        'Revisione caldaia',
        'Inesistente',
        'Chi sono',
      ],
    });
    expect(merged).toMatchObject({
      path: 'Argomenti/Caldaia.md',
      title: 'Caldaia',
      merged: ['Caldaia bloccata', 'Numero del tecnico', 'Revisione caldaia'],
      skipped: ['Inesistente', 'Chi sono'],
    });
    const page = await service.read(user, 'Caldaia');
    expect(page?.note.body).toContain('## Numero del tecnico (');
    expect(page?.note.body).toContain('Mario, 333 1234567');
    expect(page?.note.body).not.toContain('Pagina creata da Ernie');
    expect(page?.note.body).not.toContain('[[Caldaia]]');
    expect(await service.read(user, 'Caldaia bloccata')).toBeNull();
    expect(index.notes.has('Note/Caldaia bloccata.md')).toBe(false);
    // Chi citava le note unite ora cita la pagina.
    const spese = await service.read(user, 'Spese di casa');
    expect(spese?.note.body).toBe(
      'Quest’anno: [[Caldaia]] chiamato due volte, [[Caldaia]] a gennaio.',
    );
    expect(spese?.note.links).toEqual(['Caldaia']);
    expect(page?.backlinks).toContain('Spese di casa');
    expect(git(`${base}/${user}`, 'log', '--format=%s', '-1')).toContain(
      'unite 3 note in «Caldaia»',
    );

    const updated = await service.update(user, 'Spese di casa', {
      body: 'Riscritta dall’app. Vedi [[Caldaia]] e [[Bollette]].',
      private: true,
      source: 'app',
    });
    expect(updated?.note).toMatchObject({
      private: true,
      source: 'app',
      links: ['Caldaia', 'Bollette'],
    });
    expect(await service.update(user, 'Non esiste', { body: 'x' })).toBeNull();
    expect(await service.remove(user, 'Spese di casa')).toBe(true);
    expect(await service.remove(user, 'Spese di casa')).toBe(false);
    expect(await service.read(user, 'Spese di casa')).toBeNull();
  });
});
