import { join } from 'node:path';
import type { Logger } from '@ernie/observability';
import type { BrainHit, BrainIndex, BrainQuery, NoteSummary } from './index-store.js';
import {
  type BrainNote,
  bodyLinks,
  isoDay,
  type NoteSource,
  type NoteType,
  parseNote,
  pathFor,
  serializeNote,
} from './note.js';
import { GitVault, type VaultOptions } from './vault.js';

export interface BrainServiceOptions {
  /** Cartella che contiene un vault per utente (`<baseDir>/<userId>`). */
  readonly baseDir: string;
  /** Remoti git per utente (es. il repository privato aperto con Obsidian). */
  readonly remotes?: ReadonlyMap<string, string>;
  readonly gitEnv?: Readonly<Record<string, string>>;
  readonly author?: { readonly name: string; readonly email: string };
  readonly index: BrainIndex;
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
  /** «Chi sono» modificata fuori da Ernie (Obsidian): i campi tornano nella scheda anagrafica. */
  readonly onChiSonoEdited?: (userId: string, fields: ChiSonoFields) => Promise<void>;
}

export interface WriteInput {
  readonly title: string;
  readonly body: string;
  readonly type?: NoteType;
  /** create: nuova (se esiste già, aggiunge in fondo); append: in fondo; replace: riscrive il testo. */
  readonly mode?: 'create' | 'append' | 'replace';
  readonly refersFrom?: string | null;
  readonly refersTo?: string | null;
  readonly place?: string | null;
  readonly coords?: readonly [number, number] | null;
  readonly links?: readonly string[];
  readonly private?: boolean;
  readonly source?: NoteSource;
  /** Tipo delle pagine collegate (per creare quelle che mancano): es. Emma → persona, Verona → luogo. */
  readonly concepts?: ReadonlyArray<{ readonly title: string; readonly type: NoteType }>;
}

export interface WriteResult {
  readonly path: string;
  readonly title: string;
  readonly created: boolean;
  readonly links: readonly string[];
  /** Pagine-concetto create perché collegate e mancanti. */
  readonly newPages: readonly string[];
}

export interface ReadResult {
  readonly note: BrainNote;
  readonly backlinks: readonly string[];
}

/** Campi della scheda anagrafica che passano per la pagina «Chi sono». */
export interface ChiSonoFields {
  fullName?: string | null;
  preferredName?: string | null;
  birthDate?: string | null;
  gender?: string | null;
  city?: string | null;
  occupation?: string | null;
  email?: string | null;
}

export interface ChiSonoInput extends ChiSonoFields {
  readonly family: ReadonlyArray<{
    readonly name?: string | null;
    readonly relation: string;
    readonly birthDate?: string | null;
    readonly notes?: string | null;
  }>;
  /**
   * Luoghi della scheda (richiesta dell'utente, 16 ott 2026: «li dovrei trovare anche nel Second Brain»): una nota
   * per luogo nella cartella Luoghi, collegata a «Chi sono», da legare ad altri concetti.
   */
  readonly places?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly address?: string | null;
    readonly lat?: number | null;
    readonly lng?: number | null;
  }>;
}

/** «casa» → «Casa»: titolo della nota di un luogo della scheda. */
export function placeNoteTitle(label: string): string {
  const t = label.trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : t;
}

/** Righe che Ernie scrive nella nota di un luogo: si aggiornano quando il luogo cambia, il resto no. */
function placeNoteLines(pl: { label: string; address?: string | null }): {
  intro: string;
  usage: string;
} {
  const preps: Record<string, string> = {
    casa: 'a casa',
    lavoro: 'al lavoro',
    ufficio: 'in ufficio',
    scuola: 'a scuola',
    palestra: 'in palestra',
    università: 'all’università',
  };
  const at = preps[pl.label] ?? `a ${pl.label}`;
  return {
    intro: `Uno dei luoghi della tua scheda anagrafica (vedi [[Chi sono]])${pl.address ? `: ${pl.address}` : ''}.`,
    usage: `Con Ernie: «ricordami … quando arrivo ${at}», «portami ${at}». Indirizzo e posizione si cambiano nell’app, in Impostazioni › La tua scheda › Luoghi; qui sotto puoi aggiungere quello che vuoi e collegarlo ad altre note.`,
  };
}

/** Id del luogo della scheda scritto nelle proprietà della nota (`scheda: "…"`): segue le rinomine. */
function schedaId(note: BrainNote): string | null {
  const line = note.extra?.find((l) => /^scheda:\s*/u.test(l));
  if (!line) return null;
  const raw = line.replace(/^scheda:\s*/u, '').trim();
  try {
    const v = JSON.parse(raw);
    return typeof v === 'string' ? v : null;
  } catch {
    return raw || null;
  }
}

const CHI_SONO_KEYS: Array<[keyof ChiSonoFields, string]> = [
  ['fullName', 'nome'],
  ['preferredName', 'chiamami'],
  ['birthDate', 'nascita'],
  ['gender', 'genere'],
  ['city', 'citta'],
  ['occupation', 'lavoro'],
  ['email', 'email'],
];

const ERNIE_AUTHOR = 'Ernie';

const today = () =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long' }).format(
    new Date(),
  );

const nowIso = () => new Date().toISOString().slice(0, 16);

const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

/** «1975-05-03» → «3 maggio 1975», «--06-21» → «21 giugno»; altrimenti com'è. */
function italianDate(v: string): string {
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const part = /^--(\d{2})-(\d{2})$/.exec(v);
  if (full) return `${Number(full[3])} ${MONTHS[Number(full[2]) - 1] ?? ''} ${full[1]}`;
  if (part) return `${Number(part[2])} ${MONTHS[Number(part[1]) - 1] ?? ''}`;
  return v;
}

export function createBrainService(opts: BrainServiceOptions) {
  const vaults = new Map<string, GitVault>();
  const indexed = new Set<string>();
  const author = opts.author ?? { name: ERNIE_AUTHOR, email: 'ernie@localhost' };

  const vault = (userId: string): GitVault => {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('utente non valido');
    let v = vaults.get(userId);
    if (!v) {
      const remote = opts.remotes?.get(userId);
      const vo: VaultOptions = {
        dir: join(opts.baseDir, userId),
        author,
        ...(remote ? { remote } : {}),
        ...(opts.gitEnv ? { env: opts.gitEnv } : {}),
      };
      v = new GitVault(vo);
      vaults.set(userId, v);
    }
    return v;
  };

  const reindex = async (userId: string, only?: { changed: string[]; removed: string[] }) => {
    const v = vault(userId);
    const paths = only ? only.changed : await v.list();
    let updated = 0;
    for (const p of paths) {
      const text = await v.read(p);
      if (text === null) continue;
      if (await opts.index.upsert(userId, parseNote(p, text))) updated++;
    }
    const removed = only
      ? only.removed
      : [...(await opts.index.paths(userId)).keys()].filter((p) => !paths.includes(p));
    for (const p of removed) await opts.index.remove(userId, p);
    return { updated, removed: removed.length };
  };

  /** La prima volta per utente: vault pronto e indice allineato ai file. */
  const ready = async (userId: string) => {
    if (indexed.has(userId)) return;
    await vault(userId).ensure();
    await reindex(userId);
    indexed.add(userId);
  };

  const readNote = async (userId: string, ref: string): Promise<BrainNote | null> => {
    await ready(userId);
    const v = vault(userId);
    const byIndex = ref.toLowerCase().endsWith('.md')
      ? await opts.index.get(userId, ref)
      : await opts.index.findByTitle(userId, ref);
    const path = byIndex?.path ?? (ref.toLowerCase().endsWith('.md') ? ref : null);
    if (!path) return null;
    const text = await v.read(path);
    return text === null ? null : parseNote(path, text);
  };

  const service = {
    vault,
    ready,
    reindex,

    async write(userId: string, input: WriteInput): Promise<WriteResult> {
      await ready(userId);
      const v = vault(userId);
      const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Senza titolo';
      let existing = await readNote(userId, title);
      // Titolo con caratteri tolti dal nome del file («Codice: caldaia» → «Codice caldaia.md»): l'indice non lo
      // ritrova per titolo, ma il file c'è. Si aggiunge in fondo invece di sovrascriverlo (revisione del 16 ott).
      if (!existing) {
        const path = pathFor(input.type ?? 'nota', title);
        const raw = await v.read(path);
        if (raw !== null) existing = parseNote(path, raw);
      }
      const mode = input.mode ?? 'create';
      const links = new Set([
        ...(input.links ?? []).map((l) => l.replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean),
      ]);
      const body = input.body.trim();
      let note: BrainNote;
      let created = false;
      if (!existing) {
        created = true;
        const type = input.type ?? 'nota';
        const refersFrom = isoDay(input.refersFrom);
        const refersTo = isoDay(input.refersTo);
        note = {
          path: pathFor(type, title),
          title,
          type,
          created: nowIso(),
          ...(refersFrom ? { refersFrom } : {}),
          ...(refersTo ? { refersTo } : {}),
          ...(input.place ? { place: input.place.slice(0, 80) } : {}),
          ...(input.coords ? { coords: input.coords } : {}),
          links: [...links],
          private: input.private ?? false,
          ...(input.source ? { source: input.source } : {}),
          body,
        };
      } else {
        const appended =
          mode === 'replace'
            ? body
            : `${existing.body.replace(/\s+$/, '')}\n\n### ${today()}\n\n${body}`;
        const refersFrom = isoDay(input.refersFrom) ?? existing.refersFrom;
        const refersTo = isoDay(input.refersTo) ?? existing.refersTo;
        const place = input.place ?? existing.place;
        const coords = input.coords ?? existing.coords;
        note = {
          ...existing,
          ...(refersFrom ? { refersFrom } : {}),
          ...(refersTo ? { refersTo } : {}),
          ...(place ? { place } : {}),
          ...(coords ? { coords } : {}),
          links: [...new Set([...existing.links, ...links])],
          private: input.private ?? existing.private,
          body: appended,
        };
      }
      // I collegamenti scritti nel testo con [[…]] contano già: non si ripetono nel frontmatter.
      const all = [...new Set([...note.links, ...bodyLinks(note.body)])];
      note = { ...note, links: all };
      // Pagine-concetto: ogni collegamento senza pagina ne ottiene una, con il tipo indicato e il rimando.
      const kinds = new Map(
        (input.concepts ?? []).map((c) => [c.title.trim().toLowerCase(), c.type]),
      );
      const stubs: BrainNote[] = [];
      for (const link of all.slice(0, 12)) {
        if (link.toLowerCase() === title.toLowerCase()) continue;
        if (await opts.index.findByTitle(userId, link)) continue;
        const type = kinds.get(link.toLowerCase()) ?? 'argomento';
        const path = pathFor(type, link);
        if (await v.exists(path)) continue;
        stubs.push({
          path,
          title: link,
          type: type === 'chi-sono' ? 'argomento' : type,
          created: nowIso(),
          links: [title],
          private: false,
          source: input.source ?? 'chat',
          body: `# ${link}\n\nPagina creata da Ernie: compare in [[${title}]].`,
        });
      }
      const verb = created ? 'nuova nota' : mode === 'replace' ? 'riscritta' : 'aggiunto a';
      const extra = stubs.length ? ` (+ ${stubs.map((p) => `«${p.title}»`).join(', ')})` : '';
      await v.commit(
        [note, ...stubs].map((n) => ({ path: n.path, content: serializeNote(n) })),
        `Ernie: ${verb} «${title}»${extra}`,
      );
      for (const n of [note, ...stubs]) await opts.index.upsert(userId, n);
      return {
        path: note.path,
        title: note.title,
        created,
        links: all,
        newPages: stubs.map((p) => p.title),
      };
    },

    async read(userId: string, ref: string): Promise<ReadResult | null> {
      const note = await readNote(userId, ref);
      if (!note) return null;
      const back = await opts.index.list(userId, {
        linkedTo: note.title,
        includePrivate: true,
        limit: 50,
      });
      return { note, backlinks: back.filter((b) => b.path !== note.path).map((b) => b.title) };
    },

    async search(userId: string, q: BrainQuery): Promise<BrainHit[]> {
      await ready(userId);
      return opts.index.search(userId, q);
    },

    /** Nota da accennare in conversazione (B2), oppure null. */
    async suggest(userId: string, text: string, exclude: readonly string[] = []) {
      await ready(userId);
      return opts.index.suggest(userId, text, exclude);
    },

    async list(userId: string, q: BrainQuery = {}): Promise<NoteSummary[]> {
      await ready(userId);
      return opts.index.list(userId, q);
    },

    /** Pagina «Chi sono» dalla scheda anagrafica, con le pagine-persona dei familiari (create se mancano). */
    async writeChiSono(userId: string, p: ChiSonoInput): Promise<void> {
      await ready(userId);
      const v = vault(userId);
      const files: Array<{ path: string; content: string | null }> = [];
      const family = p.family.map((m) => {
        const name = m.name?.trim();
        const extra = [
          m.birthDate ? `nato/a il ${italianDate(m.birthDate)}` : null,
          m.notes ?? null,
        ]
          .filter(Boolean)
          .join(', ');
        return `- ${name ? `[[${name}]]` : m.relation}${name ? ` (${m.relation})` : ''}${extra ? `, ${extra}` : ''}`;
      });
      // I dati anche nel testo: le proprietà in testa le vede Obsidian, ma l'app e la ricerca leggono il testo.
      const labels: Array<[keyof ChiSonoFields, string]> = [
        ['fullName', 'Nome'],
        ['preferredName', 'Come vuole essere chiamato'],
        ['birthDate', 'Nascita'],
        ['gender', 'Genere'],
        ['city', 'Vive a'],
        ['occupation', 'Lavoro'],
        ['email', 'Email'],
      ];
      const data = labels
        .filter(([k]) => p[k])
        .map(
          ([k, label]) => `- **${label}:** ${k === 'birthDate' ? italianDate(p[k] ?? '') : p[k]}`,
        );
      const places = (p.places ?? []).filter((pl) => pl.label.trim());
      const placeLines = places.map(
        (pl) => `- [[${placeNoteTitle(pl.label)}]]${pl.address ? `: ${pl.address}` : ''}`,
      );
      const body = [
        '# Chi sono',
        '',
        ...(data.length
          ? data
          : ['Ancora nessun dato: Ernie compila la scheda quando ne parlate.']),
        '',
        ...(family.length ? ['## Famiglia', '', ...family, ''] : []),
        ...(placeLines.length ? ['## Luoghi', '', ...placeLines, ''] : []),
        '_Generata dalla scheda anagrafica di Ernie. Nome, chiamami, nascita, genere, città e lavoro si possono correggere anche nelle proprietà in testa a questa pagina; la famiglia nell’app, in Impostazioni › La tua scheda._',
      ].join('\n');
      // Tutti i campi, anche vuoti: in Obsidian si vede cosa si può compilare.
      const extra = CHI_SONO_KEYS.map(([k, label]) => `${label}: ${JSON.stringify(p[k] ?? '')}`);
      const old = await v.read('Chi sono.md');
      const created = old ? parseNote('Chi sono.md', old).created : nowIso();
      const note: BrainNote = {
        path: 'Chi sono.md',
        title: 'Chi sono',
        type: 'chi-sono',
        created,
        links: [],
        private: false,
        source: 'scheda',
        body,
        extra,
      };
      files.push({ path: note.path, content: serializeNote(note) });
      for (const m of p.family) {
        const name = m.name?.trim();
        if (!name) continue;
        const path = pathFor('persona', name);
        if (await v.exists(path)) continue;
        files.push({
          path,
          content: serializeNote({
            path,
            title: name,
            type: 'persona',
            created: nowIso(),
            links: ['Chi sono'],
            private: false,
            source: 'scheda',
            body: `# ${name}\n\n${m.relation[0]?.toUpperCase() ?? ''}${m.relation.slice(1)} (vedi [[Chi sono]]).${m.birthDate ? `\n\nNascita: ${m.birthDate}.` : ''}`,
          }),
        });
      }
      // Una nota per luogo in Luoghi: indirizzo e coordinate dalla scheda (che per questi luoghi è la fonte), il
      // testo resta di chi lo scrive (collegamenti ad altri concetti fatti in Obsidian). Rinomina: la nota segue.
      const luoghi: BrainNote[] = [];
      for (const s of await opts.index.list(userId, { type: 'luogo', limit: 200 })) {
        const raw = await v.read(s.path);
        if (raw) luoghi.push(parseNote(s.path, raw));
      }
      for (const pl of places) {
        const title = placeNoteTitle(pl.label);
        const path = pathFor('luogo', title);
        const coords =
          typeof pl.lat === 'number' && typeof pl.lng === 'number'
            ? ([pl.lat, pl.lng] as const)
            : undefined;
        const moved = luoghi.find((n) => schedaId(n) === pl.id && n.path !== path);
        const existing =
          luoghi.find((n) => n.path === path) ??
          (moved
            ? { ...moved, path, title, body: moved.body.replace(/^# .*$/mu, `# ${title}`) }
            : null);
        const extra = [
          ...(existing?.extra ?? []).filter((l) => !/^scheda:/u.test(l)),
          `scheda: ${JSON.stringify(pl.id)}`,
        ];
        const lines = placeNoteLines(pl);
        const note: BrainNote = existing
          ? {
              ...existing,
              body: existing.body
                .replace(/^Uno dei luoghi della tua scheda anagrafica .*$/mu, lines.intro)
                .replace(/^Con Ernie: «ricordami … quando arrivo .*$/mu, lines.usage),
              ...(pl.address ? { place: pl.address } : {}),
              ...(coords ? { coords } : {}),
              links: [...new Set([...existing.links, 'Chi sono'])],
              extra,
            }
          : {
              path,
              title,
              type: 'luogo',
              created: nowIso(),
              ...(pl.address ? { place: pl.address } : {}),
              ...(coords ? { coords } : {}),
              links: ['Chi sono'],
              private: false,
              source: 'scheda',
              body: [`# ${title}`, '', lines.intro, '', lines.usage].join('\n'),
              extra,
            };
        const content = serializeNote(note);
        if (moved) files.push({ path: moved.path, content: null });
        const before = luoghi.find((n) => n.path === path);
        if (!before || serializeNote(before) !== content) files.push({ path, content });
      }
      if (old === files[0]?.content && files.length === 1) return;
      await v.commit(files, 'Ernie: aggiornata «Chi sono» dalla scheda');
      for (const f of files) {
        if (f.content === null) await opts.index.remove(userId, f.path);
        else await opts.index.upsert(userId, parseNote(f.path, f.content));
      }
    },

    /**
     * Pagine generate da Ernie (es. la sezione salute): riservate, scritte per intero a ogni aggiornamento,
     * con la data di nascita conservata. Un solo commit per tutte.
     */
    async writeGenerated(
      userId: string,
      notes: ReadonlyArray<{
        readonly path: string;
        readonly title: string;
        readonly type: NoteType;
        readonly body: string;
        readonly links?: readonly string[];
        readonly refersFrom?: string;
        readonly source?: NoteSource;
      }>,
      message: string,
    ): Promise<void> {
      await ready(userId);
      const v = vault(userId);
      const files: BrainNote[] = [];
      for (const n of notes) {
        const old = await v.read(n.path);
        const created = old ? parseNote(n.path, old).created : nowIso();
        const refersFrom = isoDay(n.refersFrom);
        const note: BrainNote = {
          path: n.path,
          title: n.title,
          type: n.type,
          created,
          ...(refersFrom ? { refersFrom } : {}),
          links: [...new Set([...(n.links ?? []), ...bodyLinks(n.body)])],
          private: true,
          ...(n.source ? { source: n.source } : {}),
          body: n.body,
        };
        if (old !== serializeNote(note)) files.push(note);
      }
      if (!files.length) return;
      await v.commit(
        files.map((n) => ({ path: n.path, content: serializeNote(n) })),
        message,
      );
      for (const n of files) await opts.index.upsert(userId, n);
    },

    /** Modifica dall'app (B3): testo e riservatezza di una nota esistente; null se non c'è. */
    async update(
      userId: string,
      ref: string,
      patch: { body?: string; private?: boolean; source?: NoteSource },
    ): Promise<ReadResult | null> {
      const existing = await readNote(userId, ref);
      if (!existing) return null;
      const body = (patch.body ?? existing.body).trim();
      const note: BrainNote = {
        ...existing,
        links: [...new Set([...existing.links, ...bodyLinks(body)])],
        private: patch.private ?? existing.private,
        ...(patch.source ? { source: patch.source } : {}),
        body,
      };
      await vault(userId).commit(
        [{ path: note.path, content: serializeNote(note) }],
        `Ernie: modificata «${note.title}» dall'app`,
      );
      await opts.index.upsert(userId, note);
      return service.read(userId, note.path);
    },

    /** Cancella una nota (B3): resta nella cronologia git. False se non esiste. */
    async remove(userId: string, ref: string): Promise<boolean> {
      const existing = await readNote(userId, ref);
      if (!existing) return false;
      await vault(userId).commit(
        [{ path: existing.path, content: null }],
        `Ernie: eliminata «${existing.title}»`,
      );
      await opts.index.remove(userId, existing.path);
      return true;
    },

    /**
     * Riordino (B3, «queste 8 note sulla caldaia: le unisco?»): unisce più note in una pagina, una sezione per
     * nota con la sua data; le note originali spariscono (restano nella cronologia) e chi le citava ora cita la
     * pagina. Tutto in un commit.
     */
    async merge(
      userId: string,
      input: { into: string; notes: readonly string[]; type?: NoteType },
    ): Promise<{ path: string; title: string; merged: string[]; skipped: string[] }> {
      await ready(userId);
      const v = vault(userId);
      const targetTitle = input.into.replace(/\s+/g, ' ').trim().slice(0, 120);
      const target = await readNote(userId, targetTitle);
      const sources: BrainNote[] = [];
      const skipped: string[] = [];
      for (const t of input.notes) {
        const n = await readNote(userId, t);
        if (
          !n ||
          n.type === 'chi-sono' ||
          n.type === 'salute' ||
          n.path === target?.path ||
          sources.some((s) => s.path === n.path)
        ) {
          skipped.push(t);
          continue;
        }
        sources.push(n);
      }
      if (!sources.length) throw new Error('nessuna nota da unire');
      const stub = /^Pagina creata da Ernie: compare in \[\[[^\]]*\]\]\.?\s*$/m;
      const base = (target ? target.body.replace(stub, '') : `# ${targetTitle}`).replace(
        /\s+$/,
        '',
      );
      // Dentro la pagina il rimando a se stessa non serve: «[[Caldaia]]» diventa «Caldaia».
      const selfLink = new RegExp(
        `\\[\\[${targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|([^\\]]*))?\\]\\]`,
        'gi',
      );
      const sections = sources.map((n) => {
        const text = n.body
          .replace(/^#\s+[^\n]*\n?/, '')
          .replace(selfLink, (_m, alias?: string) => alias || targetTitle)
          .trim();
        const when = n.refersFrom ?? n.created.slice(0, 10);
        return `## ${n.title} (${italianDate(when)})\n\n${text}`;
      });
      const gone = new Set(sources.map((n) => n.title.toLowerCase()));
      const links = [
        ...new Set([...(target?.links ?? []), ...sources.flatMap((n) => n.links)]),
      ].filter((l) => l.toLowerCase() !== targetTitle.toLowerCase() && !gone.has(l.toLowerCase()));
      const type = target?.type ?? input.type ?? 'argomento';
      const note: BrainNote = target
        ? {
            ...target,
            links,
            private: target.private || sources.some((n) => n.private),
            body: `${base}\n\n${sections.join('\n\n')}`,
          }
        : {
            path: pathFor(type === 'chi-sono' ? 'argomento' : type, targetTitle),
            title: targetTitle,
            type: type === 'chi-sono' ? 'argomento' : type,
            created: nowIso(),
            links,
            private: sources.some((n) => n.private),
            source: 'chat',
            body: `${base}\n\n${sections.join('\n\n')}`,
          };
      // Chi citava una nota unita ora cita la pagina: il grafo resta intero (anche in Obsidian).
      const rewritten = new Map<string, BrainNote>();
      for (const n of sources) {
        const citing = await opts.index.list(userId, {
          linkedTo: n.title,
          includePrivate: true,
          limit: 100,
        });
        for (const c of citing) {
          if (c.path === note.path || sources.some((s) => s.path === c.path)) continue;
          const cur = rewritten.get(c.path) ?? (await readNote(userId, c.path));
          if (!cur) continue;
          const re = new RegExp(
            `\\[\\[${n.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`,
            'gi',
          );
          const body = cur.body.replace(re, `[[${note.title}]]`);
          const curLinks = [
            ...new Set(
              cur.links.map((l) => (l.toLowerCase() === n.title.toLowerCase() ? note.title : l)),
            ),
          ];
          rewritten.set(c.path, { ...cur, links: curLinks, body });
        }
      }
      const files = [
        { path: note.path, content: serializeNote(note) },
        ...sources.map((n) => ({ path: n.path, content: null })),
        ...[...rewritten.values()].map((n) => ({ path: n.path, content: serializeNote(n) })),
      ];
      await v.commit(files, `Ernie: unite ${sources.length} note in «${note.title}»`);
      await opts.index.upsert(userId, note);
      for (const n of sources) await opts.index.remove(userId, n.path);
      for (const n of rewritten.values()) await opts.index.upsert(userId, n);
      return { path: note.path, title: note.title, merged: sources.map((n) => n.title), skipped };
    },

    /**
     * Candidati al riordino (B3): pagine-concetto (persona, luogo, progetto, argomento) con almeno `minNotes`
     * note collegate. Ernie le propone in conversazione; l'unione avviene solo se l'utente dice di sì.
     */
    async reorganizeCandidates(
      userId: string,
      o: { minNotes?: number; max?: number } = {},
    ): Promise<Array<{ title: string; type: NoteType; notes: string[] }>> {
      await ready(userId);
      const minNotes = o.minNotes ?? 5;
      const max = o.max ?? 3;
      const pages = (await opts.index.list(userId, { includePrivate: false, limit: 300 })).filter(
        (n) => ['persona', 'luogo', 'progetto', 'argomento'].includes(n.type),
      );
      const out: Array<{ title: string; type: NoteType; notes: string[] }> = [];
      for (const page of pages) {
        const linked = (
          await opts.index.list(userId, { linkedTo: page.title, includePrivate: false, limit: 100 })
        ).filter((n) => n.type === 'nota' && n.path !== page.path);
        if (linked.length >= minNotes)
          out.push({ title: page.title, type: page.type, notes: linked.map((n) => n.title) });
        if (out.length >= max) break;
      }
      return out;
    },

    /** Sincronizza i vault con remoto: reindicizza i file cambiati e riporta in scheda le modifiche a «Chi sono». */
    async syncAll(): Promise<Array<{ userId: string; changed: number; conflict: boolean }>> {
      const out: Array<{ userId: string; changed: number; conflict: boolean }> = [];
      for (const userId of opts.remotes?.keys() ?? []) {
        try {
          await ready(userId);
          const v = vault(userId);
          const r = await v.sync();
          if (r.changed.length || r.removed.length) await reindex(userId, r);
          if (r.conflict)
            opts.logger?.warn({ userId }, 'second brain: conflitto risolto a favore di Obsidian');
          // Se qualcuno diverso da Ernie ha toccato «Chi sono» (anche se poi c'è un'unione), i campi tornano in scheda.
          const touchedBy = r.authors['Chi sono.md'] ?? [];
          if (opts.onChiSonoEdited && touchedBy.some((a) => a !== author.name)) {
            const text = await v.read('Chi sono.md');
            if (text)
              await opts.onChiSonoEdited(userId, parseChiSono(parseNote('Chi sono.md', text)));
          }
          out.push({ userId, changed: r.changed.length + r.removed.length, conflict: r.conflict });
        } catch (err) {
          opts.logger?.warn(
            { userId, err: err instanceof Error ? err.message : String(err) },
            'second brain: sincronizzazione fallita',
          );
        }
      }
      return out;
    },
  };
  return service;
}

export type BrainService = ReturnType<typeof createBrainService>;

/** Campi della scheda dal frontmatter di «Chi sono» (righe `nome: "…"`). */
export function parseChiSono(note: BrainNote): ChiSonoFields {
  const out: ChiSonoFields = {};
  for (const line of note.extra ?? []) {
    const m = /^([a-z]+):\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = CHI_SONO_KEYS.find(([, label]) => label === (m[1] ?? '').toLowerCase())?.[0];
    if (!key) continue;
    let value = (m[2] ?? '').trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.replace(/^"|"$/g, '');
      }
    }
    out[key] = value || null;
  }
  for (const [key] of CHI_SONO_KEYS) if (!(key in out)) out[key] = null;
  return out;
}
