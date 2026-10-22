import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BrainHit, BrainIndex, NoteSummary } from './index-store.js';
import { applyKnowledgeUpdate } from './knowledge.js';
import { type BrainNote, parseNote, serializeNote } from './note.js';
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
  it('legge i luoghi collegati nel riepilogo senza mutare note o condividere luoghi riservati', async () => {
    const brain = createBrainService({ baseDir: join(tmp, 'overview'), index: memoryIndex() });
    await brain.write(user, {
      title: 'Casa dei genitori di Anna',
      type: 'luogo',
      body: 'Ingresso dal giardino.',
      coords: [45.123456789, 13.123456789],
      mode: 'create',
    });
    await brain.write(user, {
      title: 'Indirizzo riservato',
      type: 'luogo',
      body: 'Appunto personale.',
      private: true,
      mode: 'create',
    });
    await brain.write(user, {
      title: 'Anna Rossi',
      type: 'persona',
      body: 'Compagna.\n\nI genitori vivono a [[Trieste]].\n\n[[Casa dei genitori di Anna]]\n\n[[Indirizzo riservato]]',
      mode: 'create',
    });
    const r = await brain.read(user, 'Anna Rossi');
    expect(r?.overview?.facts.some((f) => f.text.includes('I genitori vivono'))).toBe(true);
    expect(
      r?.overview?.places.find((p) => p.title === 'Casa dei genitori di Anna')?.coords,
    ).toEqual([45.123456789, 13.123456789]);
    expect(r?.overview?.places.some((p) => p.title === 'Indirizzo riservato')).toBe(false);
    expect((await brain.read(user, 'Anna Rossi'))?.note.body).toBe(r?.note.body);
    const edited = await brain.update(user, 'Anna Rossi', {
      body: `${r?.note.body}\n\n[[../outside.md]]`,
    });
    expect(edited?.overview?.places.some((p) => p.title === 'Casa dei genitori di Anna')).toBe(
      true,
    );
  });

  it('consolida subito scritture, aggiunte e luoghi della scheda senza ricorsione', async () => {
    const seen: string[][] = [];
    const brain = createBrainService({
      baseDir: join(tmp, 'local-area'),
      index: memoryIndex(),
      onNotesWritten: async (id, paths) => {
        seen.push([...paths]);
        await brain.reconcile(id, undefined, undefined, paths);
      },
    });
    await brain.write(user, { title: 'Anna Rossi', type: 'persona', body: 'Compagna.' });
    await brain.write(user, { title: 'Appunto', body: '[[Anna Rossi]] porta il 41.' });
    expect((await brain.read(user, 'Anna Rossi'))?.note.body).toContain('porta il 41.');
    await brain.write(user, { title: 'Appunto', mode: 'append', body: 'Preferisce il blu.' });
    await brain.writeChiSono(user, {
      family: [{ name: 'Anna Rossi', relation: 'compagna' }],
      places: [{ id: 'home', label: 'Casa Anna Rossi', address: 'Via Verdi 7' }],
    });
    expect((await brain.read(user, 'Anna Rossi'))?.note.body).toContain('Via Verdi 7');
    expect(seen).toHaveLength(4);
    await brain.update(user, 'Appunto', { private: true });
    expect((await brain.read(user, 'Anna Rossi'))?.note.body).not.toContain('porta il 41.');
    expect((await brain.read(user, 'Anna Rossi'))?.note.body).toContain('Via Verdi 7');
  });

  it('un errore nel consolidamento non fa fallire né ripetere una nota già salvata', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'area-failure'),
      index: memoryIndex(),
      onNotesWritten: async () => {
        throw new Error('concurrent update');
      },
    });
    const result = await brain.write(user, { title: 'Nota salvata', body: 'Contenuto originale.' });
    expect(result.created).toBe(true);
    expect((await brain.read(user, 'Nota salvata'))?.note.body).toContain('Contenuto originale.');
  });

  it('ricorda le unioni dopo riavvio, riscrive link con percorsi e usa il nome canonico nelle nuove scritture', async () => {
    const baseDir = join(tmp, 'identity-vault');
    const index = memoryIndex();
    const service = createBrainService({ baseDir, index });
    await service.writeChiSono(user, {
      family: [
        { name: 'Anna Rossi', relation: 'compagna', birthDate: '1980-01-01' },
        { name: 'Anna', relation: 'compagna', notes: 'Porta il 41.' },
      ],
    });
    await service.write(user, {
      title: 'Casa',
      type: 'luogo',
      body: 'Casa di [[Persone/Anna.md|Anna]], in centro.',
    });
    await service.merge(user, { into: 'Anna Rossi', notes: ['Anna'] });
    expect(await service.read(user, 'Anna')).toBeNull();
    expect((await service.read(user, 'Casa'))?.note.body).toContain(
      '[[Persone/Anna Rossi.md|Anna]]',
    );
    const body = (await service.read(user, 'Anna Rossi'))?.note.body ?? '';
    expect(body.match(/<!-- ernie:family-profile /gu)).toHaveLength(1);
    expect(body).toContain('Porta il 41.');
    const restarted = createBrainService({ baseDir, index: memoryIndex() });
    expect(await restarted.identities(user)).toEqual([
      {
        title: 'Anna Rossi',
        path: 'Persone/Anna Rossi.md',
        type: 'persona',
        aliases: [{ title: 'Anna', path: 'Persone/Anna.md' }],
      },
    ]);
    await restarted.write(user, { title: 'Anna', type: 'persona', body: 'Preferisce il tè.' });
    expect(await restarted.read(user, 'Anna')).toBeNull();
    expect((await restarted.read(user, 'Anna Rossi'))?.note.body).toContain('Preferisce il tè.');
  });

  it('consolida copie esatte senza fondere omonimi differenti o pagine private, poi resta stabile', async () => {
    const service = createBrainService({
      baseDir: join(tmp, 'copies-vault'),
      index: memoryIndex(),
    });
    await service.write(user, {
      title: 'Anna Rossi',
      type: 'persona',
      body: '# Anna Rossi\n\nInsegna matematica alla scuola Manzoni dal 2020.',
    });
    const raw = await service.vault(user).read('Persone/Anna Rossi.md');
    await service.vault(user).commit([{ path: 'Archivio/Anna Rossi.md', content: raw }], 'copia');
    await service.reindex(user);
    expect(await service.consolidateDuplicates(user)).toBe(1);
    expect(await service.consolidateDuplicates(user)).toBe(0);
    const head = await service.vault(user).head();
    await service.consolidateDuplicates(user);
    expect(await service.vault(user).head()).toBe(head);
    await service
      .vault(user)
      .commit(
        [{ path: 'Omonimi/Anna Rossi.md', content: (raw ?? '').replace('matematica', 'italiano') }],
        'omonima',
      );
    await service.reindex(user);
    expect(await service.consolidateDuplicates(user)).toBe(0);
  });

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

  it('titolo con caratteri vietati nel nome del file: la seconda scrittura aggiunge, non sovrascrive', async () => {
    const index = memoryIndex();
    const brain = createBrainService({ baseDir: join(tmp, 'vaults-titoli'), index });
    await brain.write(user, { title: 'Codice: caldaia', body: 'Il codice è 1234.' });
    // Come dopo un riavvio: l'indice non conosce più il titolo con i due punti.
    index.notes.clear();
    await brain.write(user, { title: 'Codice: caldaia', body: 'Cambiato in 5678.' });
    const raw = git(join(tmp, 'vaults-titoli', user), 'show', 'HEAD:Note/Codice caldaia.md');
    expect(raw).toContain('Il codice è 1234.');
    expect(raw).toContain('Cambiato in 5678.');
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

describe('revisione automatica con cronologia git', () => {
  it('aggiorna la pagina della compagna e i backlink; conserva il passato e rifiuta snapshot superati', async () => {
    const baseDir = join(tmp, 'review-vault');
    const index = memoryIndex();
    const brain = createBrainService({ baseDir, index });
    await brain.writeChiSono(user, {
      family: [{ name: 'Anna', relation: 'compagna', notes: 'Ama i libri.' }],
      places: [{ id: 'p1', label: 'casa Anna', address: 'Via Roma 12' }],
    });
    await brain.write(user, { title: 'Anna', body: 'Nota personale da conservare.' });
    const before = await brain.reviewSnapshot(user);
    const result = await brain.reconcile(user, undefined, before.fingerprint);
    expect(result.changed).toBe(1);
    expect((await brain.read(user, 'Anna'))?.note.body).toContain('Via Roma 12');
    expect((await brain.read(user, 'Casa Anna'))?.backlinks).toContain('Anna');
    const head = git(join(baseDir, user), 'rev-parse', 'HEAD');
    expect((await brain.reconcile(user)).changed).toBe(0);
    expect(git(join(baseDir, user), 'rev-parse', 'HEAD')).toBe(head);
    await brain.writeChiSono(user, {
      family: [{ name: 'Anna', relation: 'compagna', notes: 'Ama la montagna.' }],
      places: [{ id: 'p1', label: 'casa Anna', address: 'Via Verdi 4' }],
    });
    expect((await brain.reconcile(user, undefined, before.fingerprint)).stale).toBe(true);
    await brain.reconcile(user);
    const anna = (await brain.read(user, 'Anna'))?.note.body;
    expect(anna).toContain('Ama la montagna.');
    expect(anna).not.toContain('Ama i libri.');
    expect(anna).toContain('Nota personale da conservare.');
    expect(anna).toContain('Via Verdi 4');
    expect(anna).not.toContain('Via Roma 12');
    expect(git(join(baseDir, user), 'show', `${head.trim()}:Persone/Anna.md`)).toContain(
      'Via Roma 12',
    );
  });
  it('la sincronizzazione famiglia conserva le modifiche manuali e le pagine riservate', async () => {
    const baseDir = join(tmp, 'review-family');
    const brain = createBrainService({ baseDir, index: memoryIndex() });
    await brain.writeChiSono(user, {
      family: [{ name: 'Anna', relation: 'compagna', notes: 'Ama i libri.' }],
    });
    const vault = brain.vault(user);
    const raw = await vault.read('Persone/Anna.md');
    await vault.commit(
      [
        {
          path: 'Persone/Anna.md',
          content: (raw ?? '').replace('Ama i libri.', 'Nota corretta a mano.'),
        },
      ],
      'correzione',
    );
    await brain.writeChiSono(user, {
      family: [{ name: 'Anna', relation: 'compagna', notes: 'Nuovo dato automatico.' }],
    });
    expect(await vault.read('Persone/Anna.md')).toContain('Nota corretta a mano.');
    expect(await vault.read('Persone/Anna.md')).not.toContain('Nuovo dato automatico.');
    await brain.write(user, {
      title: 'Privata',
      type: 'persona',
      private: true,
      body: 'Confidenziale.',
    });
    const privateBefore = await vault.read('Persone/Privata.md');
    await brain.writeChiSono(user, {
      family: [{ name: 'Privata', relation: 'amica', notes: 'Dato automatico.' }],
    });
    expect(await vault.read('Persone/Privata.md')).toBe(privateBefore);
  });
  it('il commit condizionale non sovrascrive una modifica arrivata dopo il calcolo', async () => {
    const brain = createBrainService({ baseDir: join(tmp, 'review-race'), index: memoryIndex() });
    await brain.write(user, { title: 'Anna', body: 'Originale.' });
    const v = brain.vault(user);
    const raw = await v.read('Note/Anna.md');
    await v.commit([{ path: 'Note/Anna.md', content: 'Correzione della persona.' }], 'edit');
    await expect(
      v.commit(
        [{ path: 'Note/Anna.md', content: 'Dato automatico.' }],
        'review',
        new Map([['Note/Anna.md', raw]]),
      ),
    ).rejects.toThrow();
    expect(await v.read('Note/Anna.md')).toBe('Correzione della persona.');
  });
});

describe('migrazione delle schede famiglia precedenti ai blocchi gestiti', () => {
  it('rimuove il vecchio prefisso duplicato, mantiene note personali e fonti; il secondo passaggio non cambia nulla', async () => {
    const index = memoryIndex();
    const baseDir = join(tmp, 'legacy-family');
    const brain = createBrainService({ baseDir, index });
    const member = { name: 'Anna', relation: 'compagna', birthDate: '1980-07-08' };
    const family = [member];
    await brain.writeChiSono(user, { family });
    const v = brain.vault(user);
    const path = 'Persone/Anna.md';
    const raw = await v.read(path);
    const buggy = (raw ?? '').replace(
      '# Anna\n\n',
      '# Anna\n\nCompagna (vedi [[Chi sono]]).\n\nNascita: 1980-07-08.\n\nNota personale: ama i libri.\n\n',
    );
    await v.commit(
      [{ path, content: `${buggy}\n\nFonte personale: [[Diario]].\n` }],
      'fixture versione precedente',
    );
    await brain.writeChiSono(user, { family: [{ ...member, birthDate: '1980-07-09' }] });
    const after = await v.read(path);
    expect(after?.match(/Compagna \(vedi/g)).toHaveLength(1);
    expect(after?.match(/Nascita:/g)).toHaveLength(1);
    expect(after).toContain('1980-07-09');
    expect(after).not.toContain('1980-07-08');
    expect(after).toContain('Nota personale: ama i libri.');
    expect(after).toContain('Fonte personale: [[Diario]].');
    expect(after).toContain('<!-- ernie:family-profile');
    const head = await v.head();
    await brain.writeChiSono(user, { family: [{ ...member, birthDate: '1980-07-09' }] });
    expect(await v.head()).toBe(head);
  });

  it('non elimina prefissi personalizzati o creati dalla chat; migra le schede ancora senza blocco', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'legacy-family-preserve'),
      index: memoryIndex(),
    });
    const old = '# Anna\n\nCompagna (vedi [[Chi sono]]).\n\nNascita: 1980-07-08.';
    await brain.write(user, {
      title: 'Anna',
      type: 'persona',
      source: 'scheda',
      body: `${old}\n\nTesto personale.`,
    });
    await brain.writeChiSono(user, {
      family: [{ name: 'Anna', relation: 'compagna', birthDate: '1980-07-08' }],
    });
    const after = await brain.vault(user).read('Persone/Anna.md');
    expect(after?.match(/Nascita:/g)).toHaveLength(1);
    expect(after).toContain('Testo personale.');
    await brain.write(user, {
      title: 'Lisa',
      type: 'persona',
      source: 'chat',
      body: old.replace('Anna', 'Lisa'),
    });
    await brain.writeChiSono(user, {
      family: [{ name: 'Lisa', relation: 'compagna', birthDate: '1980-07-08' }],
    });
    expect((await brain.vault(user).read('Persone/Lisa.md'))?.match(/Nascita:/g)).toHaveLength(2);
    await brain.write(user, {
      title: 'Marta',
      type: 'persona',
      source: 'scheda',
      body: '# Marta\n\nCompagna (vedi [[Chi sono]]). Correzione personale.',
    });
    await brain.writeChiSono(user, { family: [{ name: 'Marta', relation: 'compagna' }] });
    expect(await brain.vault(user).read('Persone/Marta.md')).toContain(
      'Compagna (vedi [[Chi sono]]). Correzione personale.',
    );
  });
});

const knownRoutine = {
  title: 'Scuola',
  days: [1, 2, 3, 4, 5],
  timeZone: 'Europe/Rome',
  startTime: '08:30',
  endTime: '16:00',
};
function fixtureNote(path: string, title: string, patch: Partial<BrainNote> = {}): BrainNote {
  return {
    path,
    title,
    type: 'persona',
    created: '2026-10-21T12:00:00Z',
    links: [],
    private: false,
    body: `# ${title}\n\nTesto utente da conservare.`,
    ...patch,
  };
}

describe('factual Second Brain: canonical Git integration without models', () => {
  it('saves partial knowledge, preserves manual text/frontmatter/history and performs no commit on a replay', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'knowledge-idempotence'),
      index: memoryIndex(),
    });
    const original = fixtureNote('Persone/Ada.md', 'Ada', {
      extra: ['custom: manuale'],
      body: '# Ada\n\nTesto utente.\n\n### 2026-01-01\n\nStorico precedente.',
    });
    await brain
      .vault(user)
      .commit([{ path: original.path, content: serializeNote(original) }], 'fixture');
    const first = await brain.updateKnowledge(user, {
      ref: original.path,
      facts: [{ label: 'Scarpe', value: '32' }],
      routines: [knownRoutine],
    });
    const id = first.note.knowledge?.routines[0]?.id;
    expect(id).toBeTruthy();
    const next = await brain.updateKnowledge(user, {
      ref: 'Ada',
      routines: [{ id, pickupTime: '16:15' }],
    });
    expect(next.note.knowledge?.routines[0]).toMatchObject({
      startTime: '08:30',
      endTime: '16:00',
      pickupTime: '16:15',
      homeTime: null,
    });
    expect(next.note.knowledge?.facts).toEqual(first.note.knowledge?.facts);
    expect(next.note.extra).toEqual(['custom: manuale']);
    expect(next.note.body).toContain('Storico precedente.');
    expect(next.note.body.match(/## Orari abituali/gu)).toHaveLength(1);
    const head = await brain.vault(user).head();
    const same = await brain.updateKnowledge(user, {
      ref: 'Ada',
      routines: [{ id, pickupTime: '16:15' }],
    });
    expect(await brain.vault(user).head()).toBe(head);
    expect(same.note.knowledge).toEqual(next.note.knowledge);
    expect(git(brain.vault(user).dir, 'show', 'HEAD~1:Persone/Ada.md')).toContain(
      '"pickupTime":null',
    );
    const edited = await brain.update(user, 'Ada', { body: '# Ada\n\nNuovo testo manuale.' });
    expect(edited?.note.knowledge).toEqual(next.note.knowledge);
    expect(edited?.note.body).toContain('Nuovo testo manuale.');
    expect(edited?.note.body).toContain('16:15');
  });

  it('serializes concurrent updates and refuses a stale legacy body writer rather than lose structured fields', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'knowledge-concurrency'),
      index: memoryIndex(),
    });
    await brain.write(user, { title: 'Ada', type: 'persona', body: 'Testo iniziale.' });
    await Promise.all([
      brain.updateKnowledge(user, { ref: 'Ada', facts: [{ label: 'Scarpe', value: '32' }] }),
      brain.updateKnowledge(user, { ref: 'Ada', routines: [knownRoutine] }),
    ]);
    const loaded = await brain.read(user, 'Ada');
    expect(loaded?.note.knowledge?.facts).toHaveLength(1);
    expect(loaded?.note.knowledge?.routines).toHaveLength(1);
    const v = brain.vault(user),
      commit = v.commit.bind(v);
    let release: () => void = () => {},
      prepared: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const spy = vi.spyOn(v, 'commit').mockImplementation(async (files, message, expected) => {
      if (message.includes('aggiunto a')) {
        prepared();
        await gate;
      }
      return commit(files, message, expected);
    });
    const legacy = brain
      .write(user, { title: 'Ada', mode: 'append', body: 'Aggiunta concorrente.' })
      .catch((error: unknown) => error);
    await waiting;
    await brain.updateKnowledge(user, { ref: 'Ada', facts: [{ label: 'Sport', value: 'Nuoto' }] });
    release();
    expect(await legacy).toBeInstanceOf(Error);
    spy.mockRestore();
    const final = await brain.read(user, 'Ada');
    expect(final?.note.knowledge?.facts.map((fact) => fact.label)).toEqual(['Scarpe', 'Sport']);
    expect(final?.note.body).toContain('Testo iniziale.');
  });

  it('rejects ambiguous subjects, generated pages and invalid knowledge without changing Git', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'knowledge-identity'),
      index: memoryIndex(),
    });
    const notes = [
      fixtureNote('Persone/Ada.md', 'Ada'),
      fixtureNote('Persone/Ada omonima.md', 'Ada'),
      fixtureNote('Salute/Profilo.md', 'Profilo', { type: 'salute', private: true }),
      fixtureNote('Chi sono.md', 'Chi sono', { type: 'chi-sono' }),
      fixtureNote('Ricette/Zuppa.md', 'Zuppa', { type: 'ricetta' }),
    ];
    await brain.vault(user).commit(
      notes.map((note) => ({ path: note.path, content: serializeNote(note) })),
      'fixture',
    );
    const head = await brain.vault(user).head();
    await expect(
      brain.updateKnowledge(user, { ref: 'Ada', facts: [{ label: 'Scarpe', value: '32' }] }),
    ).rejects.toMatchObject({ code: 'ambiguous_reference', statusCode: 409 });
    await expect(
      brain.agenda(user, { date: '2026-10-21', timeZone: 'Europe/Rome', ref: 'Ada' }),
    ).rejects.toMatchObject({ code: 'ambiguous_reference' });
    for (const ref of ['Salute/Profilo.md', 'Chi sono.md', 'Ricette/Zuppa.md'])
      await expect(
        brain.updateKnowledge(user, { ref, routines: [knownRoutine] }),
      ).rejects.toMatchObject({ code: 'managed_note' });
    await expect(
      brain.updateKnowledge(user, {
        ref: 'Persone/Ada.md',
        routines: [{ ...knownRoutine, endTime: '07:00' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_knowledge' });
    expect(await brain.vault(user).head()).toBe(head);
    const result = await brain.updateKnowledge(user, {
      ref: 'Persone/Ada.md',
      facts: [{ label: 'Scarpe', value: '32' }],
    });
    expect(result.note.path).toBe('Persone/Ada.md');
    expect((await brain.read(user, 'Persone/Ada omonima.md'))?.note.knowledge).toBeUndefined();
  });

  it('reads agenda and directory directly without embeddings, excludes private/disabled resources and reports truncation', async () => {
    const index = memoryIndex();
    const upsert = vi.spyOn(index, 'upsert');
    const brain = createBrainService({
      baseDir: join(tmp, 'knowledge-directory'),
      index,
      canUseResource: async () => false,
    });
    const knowledge = applyKnowledgeUpdate(undefined, { ref: 'Ada', routines: [knownRoutine] });
    const notes = Array.from({ length: 102 }, (_, i) =>
      fixtureNote(`Persone/Persona${i}.md`, `Persona ${String(i).padStart(3, '0')}`),
    );
    notes.push(
      fixtureNote('Persone/Ada.md', 'Ada', { knowledge }),
      fixtureNote('Persone/Riservata.md', 'Segreto', { private: true, knowledge }),
      fixtureNote('Ricette/Zuppa.md', 'Zuppa', { type: 'ricetta' }),
    );
    await brain.vault(user).commit(
      notes.map((note) => ({ path: note.path, content: serializeNote(note) })),
      'fixture',
    );
    const publicDirectory = await brain.directory(user);
    expect(publicDirectory.total).toBe(103);
    expect(publicDirectory.truncated).toBe(true);
    expect(publicDirectory.groups[0]?.count).toBe(103);
    expect(publicDirectory.groups[0]?.notes).toHaveLength(100);
    expect(publicDirectory.groups[0]?.notes[0]?.title).toBe('Ada');
    expect((await brain.directory(user, { includePrivate: true })).total).toBe(104);
    const today = await brain.agenda(user, { date: '2026-10-21', timeZone: 'Europe/Rome' });
    expect(today.entries.map((entry) => entry.noteTitle)).toEqual(['Ada']);
    expect(
      (
        await brain.agenda(user, {
          date: '2026-10-21',
          timeZone: 'Europe/Rome',
          includePrivate: true,
        })
      ).entries,
    ).toHaveLength(2);
    await expect(
      brain.agenda(user, { date: '2026-10-21', timeZone: 'Europe/Rome', ref: 'Segreto' }),
    ).rejects.toMatchObject({ code: 'note_not_found' });
    expect(upsert).not.toHaveBeenCalled();
    expect(index.notes.size).toBe(0);
  });

  it('preserves knowledge across merge or refuses differing structured records before any mutation', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'knowledge-merge'),
      index: memoryIndex(),
    });
    await brain.write(user, { title: 'Ada originale', type: 'persona', body: 'Testo originale.' });
    await brain.write(user, { title: 'Ada canonica', type: 'persona', body: 'Testo canonico.' });
    const first = await brain.updateKnowledge(user, {
      ref: 'Ada originale',
      routines: [knownRoutine],
    });
    await brain.merge(user, { into: 'Ada canonica', notes: ['Ada originale'] });
    const merged = await brain.read(user, 'Ada canonica');
    expect(merged?.note.knowledge).toEqual(first.note.knowledge);
    expect(merged?.note.body.match(/## Orari abituali/gu)).toHaveLength(1);
    expect(merged?.note.body).toContain('Testo originale.');
    await brain.write(user, { title: 'Omonima', type: 'persona', body: 'Una persona diversa.' });
    await brain.updateKnowledge(user, {
      ref: 'Omonima',
      routines: [{ ...knownRoutine, title: 'Nuoto' }],
    });
    const head = await brain.vault(user).head();
    await expect(
      brain.merge(user, { into: 'Ada canonica', notes: ['Omonima'] }),
    ).rejects.toMatchObject({ code: 'knowledge_merge_conflict' });
    expect(await brain.vault(user).head()).toBe(head);
    expect(await brain.read(user, 'Omonima')).not.toBeNull();
  });

  it('preserves knowledge through profile updates and reconciliation, refusing manually edited generated blocks', async () => {
    const brain = createBrainService({
      baseDir: join(tmp, 'knowledge-profile'),
      index: memoryIndex(),
    });
    await brain.writeChiSono(user, {
      family: [{ name: 'Ada', relation: 'figlia', notes: 'Studentessa.' }],
    });
    const first = await brain.updateKnowledge(user, { ref: 'Ada', routines: [knownRoutine] });
    await brain.writeChiSono(user, {
      family: [{ name: 'Ada', relation: 'figlia', notes: 'Ama leggere.' }],
    });
    await brain.reconcile(user);
    const after = await brain.read(user, 'Ada');
    expect(after?.note.knowledge).toEqual(first.note.knowledge);
    expect(after?.note.body).toContain('Ama leggere.');
    const raw = await brain.vault(user).read(first.note.path);
    if (raw === null) throw new Error('missing fixture');
    await brain
      .vault(user)
      .commit(
        [{ path: first.note.path, content: raw.replace('Inizio: 08:30', 'Inizio: 09:00') }],
        'manual edit',
      );
    const head = await brain.vault(user).head();
    await expect(
      brain.updateKnowledge(user, {
        ref: 'Ada',
        routines: [{ title: 'Scuola', pickupTime: '16:15' }],
      }),
    ).rejects.toMatchObject({ code: 'knowledge_render_conflict' });
    expect(await brain.vault(user).head()).toBe(head);
    expect(await brain.vault(user).read(first.note.path)).toContain('Inizio: 09:00');
    // Malformed frontmatter is kept, not silently converted into a fresh empty knowledge object.
    await brain.vault(user).commit(
      [
        {
          path: 'Persone/Corrotta.md',
          content: '---\nknowledge: {"version":99}\n---\n# Corrotta\n\nDa preservare.',
        },
      ],
      'malformed fixture',
    );
    await expect(
      brain.updateKnowledge(user, { ref: 'Corrotta', routines: [knownRoutine] }),
    ).rejects.toMatchObject({ code: 'invalid_knowledge' });
    expect(
      parseNote('Persone/Corrotta.md', (await brain.vault(user).read('Persone/Corrotta.md')) ?? '')
        .extra,
    ).toContain('knowledge: {"version":99}');
  });
});
