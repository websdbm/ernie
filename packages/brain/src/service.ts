import { join } from 'node:path';
import type { Logger } from '@ernie/observability';
import {
  identityExtra,
  mergedIdentities,
  normalizeProfileBlocks,
  withoutGeneratedQuotes,
} from './identities.js';
import type { BrainHit, BrainIndex, BrainQuery, NoteSummary } from './index-store.js';
import {
  applyKnowledgeUpdate,
  type BrainAgenda,
  BrainKnowledgeError,
  calculateBrainAgenda,
  type KnowledgeUpdate,
  knowledgeKey,
  renderKnowledgeBody,
  stripKnowledgeBody,
} from './knowledge.js';
import {
  type BrainNote,
  bodyLinks,
  isoDay,
  type NoteSource,
  type NoteType,
  parseNote,
  pathFor,
  serializeNote,
  visibleNoteBody,
} from './note.js';
import { type BrainOverview, buildBrainOverview } from './overview.js';
import {
  type BrainReviewPlan,
  contentHash,
  normalized,
  reconcileNotes,
  reviewable,
  reviewFingerprint,
  reviewNotes,
} from './reconcile.js';
import {
  type BrainResource,
  isResourceType,
  managedResourceError,
  resourceFromPath,
  resourcePath,
} from './resources.js';
import { GitVault, type VaultOptions, VaultPathError } from './vault.js';

export interface BrainServiceOptions {
  readonly canUseResource?: (userId: string, kind: BrainResource['kind']) => Promise<boolean>;
  /** Cartella che contiene un vault per utente (`<baseDir>/<userId>`). */
  readonly baseDir: string;
  /** Remoti git per utente (es. il repository privato aperto con Obsidian). */
  readonly remotes?: ReadonlyMap<string, string>;
  readonly gitEnv?: Readonly<Record<string, string>>;
  readonly author?: { readonly name: string; readonly email: string };
  readonly index: BrainIndex;
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
  /** Dopo un salvataggio riuscito, consolida solo i percorsi interessati. */
  readonly onNotesWritten?: (userId: string, paths: readonly string[]) => Promise<void>;
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

export interface BrainDirectory {
  total: number;
  groups: Array<{ type: string; count: number; notes: NoteSummary[] }>;
  truncated: boolean;
}

export interface ReadResult {
  readonly note: BrainNote;
  readonly backlinks: readonly string[];
  readonly overview?: BrainOverview | null;
  readonly related?: ReadonlyArray<{
    path: string;
    title: string;
    type: NoteType;
    resource: BrainResource | null;
    coords: readonly [number, number] | null;
  }>;
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

  const readNote = async (
    userId: string,
    ref: string,
    snapshots?: Map<string, string | null>,
  ): Promise<BrainNote | null> => {
    await ready(userId);
    const v = vault(userId);
    const byIndex = ref.toLowerCase().endsWith('.md')
      ? await opts.index.get(userId, ref)
      : await opts.index.findByTitle(userId, ref);
    const path = byIndex?.path ?? (ref.toLowerCase().endsWith('.md') ? ref : null);
    if (!path) return null;
    const resource = resourceFromPath(path);
    if (resource && opts.canUseResource && !(await opts.canUseResource(userId, resource.kind)))
      return null;
    const text = await v.read(path);
    snapshots?.set(path, text);
    return text === null ? null : parseNote(path, text);
  };

  const notifyWritten = async (userId: string, paths: readonly string[]) => {
    if (!paths.length || !opts.onNotesWritten) return;
    try {
      await opts.onNotesWritten(userId, paths);
    } catch (err) {
      // Il contenuto è già salvato: non indurre il client a reinviarlo creando duplicati.
      opts.logger?.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'consolidamento locale rinviato alla revisione giornaliera',
      );
    }
  };

  const allowedQuery = async (userId: string, q: BrainQuery): Promise<BrainQuery> => ({
    ...q,
    ...(opts.canUseResource && !(await opts.canUseResource(userId, 'recipe'))
      ? { excludeTypes: [...(q.excludeTypes ?? []), 'ricetta'] }
      : {}),
  });

  // These read paths use canonical files, without indexing/embeddings or a hidden result limit.
  const allNotes = async (userId: string): Promise<BrainNote[]> => {
    const v = vault(userId);
    await v.ensure();
    const notes: BrainNote[] = [];
    for (const path of await v.list()) {
      const raw = await v.read(path);
      if (raw !== null) notes.push(parseNote(path, raw));
    }
    return notes;
  };
  const visibleNotes = async (userId: string, includePrivate = false): Promise<BrainNote[]> => {
    const allowed = new Map<string, boolean>();
    const notes: BrainNote[] = [];
    for (const note of await allNotes(userId)) {
      if (!includePrivate && note.private) continue;
      const kind =
        resourceFromPath(note.path)?.kind ??
        (note.type === 'ricetta' ? 'recipe' : note.type === 'immagine' ? 'media' : null);
      if (kind && opts.canUseResource) {
        if (!allowed.has(kind)) allowed.set(kind, await opts.canUseResource(userId, kind));
        if (!allowed.get(kind)) continue;
      }
      notes.push(note);
    }
    return notes;
  };
  const uniqueNote = (notes: readonly BrainNote[], ref: string): BrainNote => {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 300)
      throw new BrainKnowledgeError('Riferimento non valido');
    const key = knowledgeKey(ref);
    // A path is an explicit identity; a title must be unique, never first-match.
    const matches = notes.filter((note) =>
      ref.toLowerCase().endsWith('.md')
        ? knowledgeKey(note.path) === key
        : knowledgeKey(note.title) === key,
    );
    if (!matches.length) throw new BrainKnowledgeError('Scheda non trovata', 'note_not_found', 404);
    if (matches.length !== 1)
      throw new BrainKnowledgeError(
        'Riferimento ambiguo: specificare il percorso della scheda',
        'ambiguous_reference',
        409,
      );
    const note = matches[0];
    if (!note) throw new BrainKnowledgeError('Scheda non trovata', 'note_not_found', 404);
    return note;
  };
  const assertKnowledgePage = (note: BrainNote) => {
    if (
      isResourceType(note.type) ||
      resourceFromPath(note.path) ||
      ['chi-sono', 'salute'].includes(note.type) ||
      /^(?:Salute|Ricette|Immagini)\//iu.test(note.path) ||
      note.path.toLowerCase() === 'chi sono.md'
    )
      throw new BrainKnowledgeError(
        'La pagina è generata: usare la funzione dedicata',
        'managed_note',
        409,
      );
    if (note.extra?.some((line) => /^knowledge\s*:/iu.test(line)))
      throw new BrainKnowledgeError(
        'Dati knowledge nel file non validi: correggerli prima di aggiornare',
      );
  };

  const service = {
    vault,
    ready,
    reindex,

    async directory(
      userId: string,
      input: { includePrivate?: boolean | undefined } = {},
    ): Promise<BrainDirectory> {
      const notes = await visibleNotes(userId, input.includePrivate);
      const groups = new Map<NoteType, BrainNote[]>();
      for (const note of notes) groups.set(note.type, [...(groups.get(note.type) ?? []), note]);
      return {
        total: notes.length,
        truncated: [...groups.values()].some((items) => items.length > 100),
        groups: [...groups]
          .sort(([a], [b]) => a.localeCompare(b, 'it'))
          .map(([type, items]) => ({
            type,
            count: items.length,
            notes: items
              .sort((a, b) => a.title.localeCompare(b.title, 'it') || a.path.localeCompare(b.path))
              .slice(0, 100)
              .map(
                (note): NoteSummary => ({
                  path: note.path,
                  title: note.title,
                  type: note.type,
                  created: note.created,
                  refersFrom: note.refersFrom ?? null,
                  refersTo: note.refersTo ?? null,
                  place: note.place ?? null,
                  coords: note.coords ?? null,
                  links: note.links,
                  private: note.private,
                  source: note.source ?? null,
                  resource: resourceFromPath(note.path),
                  excerpt: visibleNoteBody(note.body).slice(0, 240),
                }),
              ),
          })),
      };
    },

    async agenda(
      userId: string,
      input: {
        date: string;
        timeZone: string;
        ref?: string | undefined;
        includePrivate?: boolean | undefined;
      },
    ): Promise<BrainAgenda> {
      const notes = await visibleNotes(userId, input.includePrivate);
      const selected = input.ref ? [uniqueNote(notes, input.ref)] : notes;
      return calculateBrainAgenda(selected, input);
    },

    async updateKnowledge(userId: string, input: KnowledgeUpdate): Promise<ReadResult> {
      const v = vault(userId);
      const saved = await v.mutate(async () => {
        const existing = uniqueNote(await allNotes(userId), input.ref);
        assertKnowledgePage(existing);
        const knowledge = applyKnowledgeUpdate(existing.knowledge, input);
        if (JSON.stringify(knowledge) === JSON.stringify(existing.knowledge))
          return { files: [], message: '', result: { path: existing.path, changed: false } };
        const note: BrainNote = {
          ...existing,
          knowledge,
          body: renderKnowledgeBody(existing.body, knowledge),
        };
        return {
          files: [{ path: note.path, content: serializeNote(note) }],
          message: `Ernie: aggiornate informazioni e routine di «${note.title}»`,
          result: { path: note.path, changed: true },
        };
      });
      if (saved.changed) {
        await reindex(userId, { changed: [saved.path], removed: [] });
        await notifyWritten(userId, [saved.path]);
      }
      const result = await service.read(userId, saved.path);
      if (!result)
        throw new BrainKnowledgeError(
          'Scheda non trovata dopo aggiornamento',
          'note_not_found',
          404,
        );
      return result;
    },

    /** Identità confermate, senza includere pagine riservate o sanitarie. */
    async identities(userId: string) {
      await ready(userId);
      const out: Array<{
        title: string;
        path: string;
        type: NoteType;
        aliases: ReturnType<typeof mergedIdentities>;
      }> = [];
      for (const path of await vault(userId).list()) {
        const raw = await vault(userId).read(path);
        if (!raw) continue;
        const n = parseNote(path, raw);
        if (n.private || n.type === 'salute' || n.type === 'chi-sono') continue;
        const aliases = mergedIdentities(n);
        if (aliases.length) out.push({ title: n.title, path, type: n.type, aliases });
      }
      return out;
    },

    /** Solo copie esatte dello stesso concetto: omonimi con contenuti diversi restano separati. */
    async consolidateDuplicates(userId: string) {
      await ready(userId);
      const groups = new Map<string, BrainNote[]>();
      for (const path of await vault(userId).list()) {
        const raw = await vault(userId).read(path);
        if (!raw) continue;
        const n = parseNote(path, raw);
        if (!reviewable(n) || !['persona', 'luogo', 'progetto', 'argomento'].includes(n.type))
          continue;
        const body = withoutGeneratedQuotes(n.body)
          .replace(/<!--[\s\S]*?-->/gu, '')
          .trim();
        if (body.length < 40 || body.includes('Pagina creata da Ernie:')) continue;
        const metadata = {
          knowledge: n.knowledge,
          place: n.place,
          coords: n.coords,
          refersFrom: n.refersFrom,
          refersTo: n.refersTo,
          extra: n.extra?.filter((l) => !l.startsWith('ernie_unioni:')),
        };
        const key = `${n.type}:${normalized(n.title)}:${contentHash(body + JSON.stringify(metadata))}`;
        groups.set(key, [...(groups.get(key) ?? []), n]);
      }
      let merged = 0;
      for (const group of groups.values()) {
        if (group.length < 2 || merged >= 10) continue;
        const [target, ...sources] = group.sort(
          (a, b) =>
            Number(b.path === pathFor(b.type, b.title)) -
              Number(a.path === pathFor(a.type, a.title)) ||
            a.created.localeCompare(b.created) ||
            a.path.localeCompare(b.path),
        );
        if (!target) continue;
        await service.merge(userId, { into: target.path, notes: sources.map((n) => n.path) });
        merged += sources.length;
      }
      return merged;
    },

    /** Snapshot delle sole note non riservate per il revisore senza strumenti. */
    async reviewSnapshot(userId: string) {
      await ready(userId);
      const notes: BrainNote[] = [];
      for (const path of await vault(userId).list()) {
        const raw = await vault(userId).read(path);
        if (raw !== null) notes.push(parseNote(path, raw));
      }
      return { fingerprint: reviewFingerprint(notes), notes: reviewNotes(notes) };
    },

    /** Riordino non distruttivo, con confronto delle fonti sotto lo stesso lock delle scritture git. */
    async reconcile(
      userId: string,
      plan?: BrainReviewPlan,
      expectedFingerprint?: string,
      focusPaths?: readonly string[],
    ) {
      await ready(userId);
      const v = vault(userId);
      const before = new Map<string, string | null>();
      const notes: BrainNote[] = [];
      for (const path of await v.list()) {
        const raw = await v.read(path);
        before.set(path, raw);
        if (raw !== null) notes.push(parseNote(path, raw));
      }
      if (expectedFingerprint && reviewFingerprint(notes) !== expectedFingerprint)
        return { changed: 0, questions: [] as readonly string[], stale: true };
      const changes = reconcileNotes(notes, plan, focusPaths ? new Set(focusPaths) : undefined);
      if (changes.files.length) {
        await v.commit(
          changes.files,
          'Ernie: consolidate le informazioni con le loro fonti',
          before,
        );
        // Il push può integrare modifiche di Obsidian: l'indice deve leggere i file finali, non il piano.
        await reindex(userId);
      }
      return { changed: changes.files.length, questions: changes.questions, stale: false };
    },

    async write(userId: string, input: WriteInput): Promise<WriteResult> {
      if (input.type && isResourceType(input.type)) throw managedResourceError();
      await ready(userId);
      const v = vault(userId);
      const snapshots = new Map<string, string | null>();
      const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Senza titolo';
      const knownIdentities = await service.identities(userId);
      const canonicalRef = (ref: string): string => {
        const matches = knownIdentities.filter((n) =>
          n.aliases.some((a) =>
            [a.title, a.path, a.path.replace(/\.md$/iu, '')].some(
              (r) => r.toLowerCase() === ref.toLowerCase(),
            ),
          ),
        );
        return matches.length === 1 && matches[0] ? matches[0].path : ref;
      };
      let existing = await readNote(userId, title, snapshots);
      if (!existing) {
        const candidates = knownIdentities.filter((n) =>
          n.aliases.some((a) => a.title.toLowerCase() === title.toLowerCase()),
        );
        if (candidates.length === 1 && candidates[0])
          existing = await readNote(userId, candidates[0].path, snapshots);
      }
      // Titolo con caratteri tolti dal nome del file («Codice: caldaia» → «Codice caldaia.md»): l'indice non lo
      // ritrova per titolo, ma il file c'è. Si aggiunge in fondo invece di sovrascriverlo (revisione del 16 ott).
      if (!existing) {
        const path = pathFor(input.type ?? 'nota', title);
        const raw = await v.read(path);
        snapshots.set(path, raw);
        if (raw !== null) existing = parseNote(path, raw);
      }
      if (existing && (isResourceType(existing.type) || resourceFromPath(existing.path)))
        throw managedResourceError();
      const mode = input.mode ?? 'create';
      const links = new Set([
        ...(input.links ?? [])
          .map((l) => canonicalRef(l.replace(/^\[\[|\]\]$/g, '').trim()))
          .filter(Boolean),
      ]);
      const body = input.body
        .trim()
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (all, ref: string, alias?: string) => {
          const canonical = canonicalRef(ref);
          return canonical === ref ? all : `[[${canonical}|${alias ?? ref}]]`;
        });
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
        if (
          knownIdentities.some((n) =>
            n.aliases.some((a) =>
              [a.title, a.path, a.path.replace(/\.md$/iu, '')].some(
                (r) => r.toLowerCase() === link.toLowerCase(),
              ),
            ),
          )
        )
          continue;
        const type = kinds.get(link.toLowerCase()) ?? 'argomento';
        const path = pathFor(type, link);
        if (await v.exists(path)) continue;
        snapshots.set(path, null);
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
      if (note.knowledge) note = { ...note, body: renderKnowledgeBody(note.body, note.knowledge) };
      const verb = created ? 'nuova nota' : mode === 'replace' ? 'riscritta' : 'aggiunto a';
      const extra = stubs.length ? ` (+ ${stubs.map((p) => `«${p.title}»`).join(', ')})` : '';
      await v.commit(
        [note, ...stubs].map((n) => ({ path: n.path, content: serializeNote(n) })),
        `Ernie: ${verb} «${title}»${extra}`,
        snapshots,
      );
      for (const n of [note, ...stubs]) await opts.index.upsert(userId, n);
      await notifyWritten(
        userId,
        [note, ...stubs].map((n) => n.path),
      );
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
      const back = (
        await Promise.all(
          [note.title, note.path, note.path.replace(/\.md$/iu, '')].map(async (linkedTo) =>
            opts.index.list(
              userId,
              await allowedQuery(userId, { linkedTo, includePrivate: true, limit: 50 }),
            ),
          ),
        )
      ).flat();
      const linked = (
        await Promise.all(
          note.links.map(async (ref) => {
            try {
              return await readNote(userId, ref);
            } catch (err) {
              // Un rimando non valido non deve impedire di leggere la scheda principale.
              if (err instanceof VaultPathError) return null;
              throw err;
            }
          }),
        )
      ).filter((n): n is BrainNote => n !== null);
      return {
        note,
        overview: buildBrainOverview(note, linked),
        related: [
          ...new Map(
            [...linked, ...back]
              .filter((n) => n.path !== note.path && !n.private)
              .map((n) => [
                n.path,
                {
                  path: n.path,
                  title: n.title,
                  type: n.type,
                  resource: resourceFromPath(n.path),
                  coords: n.coords ?? null,
                },
              ]),
          ).values(),
        ],
        backlinks: [...new Set(back.filter((b) => b.path !== note.path).map((b) => b.title))],
      };
    },

    async search(userId: string, q: BrainQuery): Promise<BrainHit[]> {
      await ready(userId);
      return opts.index.search(userId, await allowedQuery(userId, q));
    },

    /** Nota da accennare in conversazione (B2), oppure null. */
    async suggest(userId: string, text: string, exclude: readonly string[] = []) {
      await ready(userId);
      const suggestion = await opts.index.suggest(userId, text, exclude);
      const resource = suggestion && resourceFromPath(suggestion.path);
      if (resource && opts.canUseResource && !(await opts.canUseResource(userId, resource.kind)))
        return null;
      return suggestion;
    },

    async list(userId: string, q: BrainQuery = {}): Promise<NoteSummary[]> {
      await ready(userId);
      return opts.index.list(userId, await allowedQuery(userId, q));
    },

    /** Pagina «Chi sono» e dati della scheda nelle pagine-persona, preservando le aggiunte manuali. */
    async writeChiSono(userId: string, p: ChiSonoInput): Promise<void> {
      await ready(userId);
      const v = vault(userId);
      const expected = new Map<string, string | null>();
      for (const path of await v.list()) expected.set(path, await v.read(path));
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
        const existingRaw = await v.read(path);
        const existing = existingRaw ? parseNote(path, existingRaw) : null;
        // Le pagine riservate restano fuori dalla sincronizzazione automatica della famiglia.
        if (existing?.private) continue;
        const profileText = `${m.relation[0]?.toUpperCase() ?? ''}${m.relation.slice(1)} (vedi [[Chi sono]]).${m.birthDate ? `\n\nNascita: ${m.birthDate}.` : ''}${m.notes ? `\n\n${m.notes}` : ''}`;
        // Le nuove informazioni della scheda sono visibili anche se la pagina esiste già.
        // Un blocco marcato permette di conservare intatto il testo aggiunto a mano.
        const start = `<!-- ernie:family-profile ${contentHash(profileText)} -->`;
        const end = '<!-- /ernie:family-profile -->';
        const block = `${start}\n${profileText}\n${end}`;
        const oldBlock =
          /<!-- ernie:family-profile ([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/ernie:family-profile -->/u;
        let oldBody = existing?.body ?? `# ${name}`;
        const oldMatch = oldBlock.exec(oldBody);
        if (oldMatch && contentHash(oldMatch[2] ?? '') !== oldMatch[1]) continue;
        // Migrazione delle pagine create dalla scheda prima dei blocchi gestiti: togli solo il
        // prefisso generato identico ai dati già nel blocco. Testo personale e varianti restano intatti.
        const previousProfile = oldMatch?.[2] ?? profileText;
        const legacyFields = previousProfile.match(
          /^([^\n]+ \(vedi \[\[Chi sono\]\]\)\.)(?:\n\nNascita: \d{4}-\d{2}-\d{2}\.)?/u,
        )?.[0];
        if (existing?.source === 'scheda' && legacyFields) {
          const prefix = `# ${name}\n\n${legacyFields}`;
          const tail = oldBody.slice(prefix.length);
          if (oldBody.startsWith(prefix) && (!tail || tail.startsWith('\n\n'))) {
            oldBody = `# ${name}${tail}`;
          }
        }
        const body = oldBlock.test(oldBody)
          ? oldBody.replace(oldBlock, () => block)
          : `${oldBody}\n\n${block}`;
        const content = serializeNote(
          existing
            ? { ...existing, body }
            : {
                path,
                title: name,
                type: 'persona',
                created: nowIso(),
                links: ['Chi sono'],
                private: false,
                source: 'scheda',
                body,
              },
        );
        if (existingRaw === content) continue;
        files.push({
          path,
          content,
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
      for (const f of files) if (!expected.has(f.path)) expected.set(f.path, null);
      await v.commit(files, 'Ernie: aggiornata «Chi sono» dalla scheda', expected);
      for (const f of files) {
        if (f.content === null) await opts.index.remove(userId, f.path);
        else await opts.index.upsert(userId, parseNote(f.path, f.content));
      }
      await notifyWritten(
        userId,
        files.filter((f) => f.path !== 'Chi sono.md').map((f) => f.path),
      );
    },

    /** Proiezione di una risorsa SQL: il chiamante serializza e rilegge sempre la fonte canonica. */
    async projectResource(
      userId: string,
      resource: BrainResource,
      input: Omit<BrainNote, 'path' | 'type'> | null,
    ) {
      await ready(userId);
      const path = resourcePath(resource);
      const v = vault(userId);
      const old = await v.read(path);
      if (!input) {
        if (old !== null)
          await v.commit([{ path, content: null }], 'Ernie: rimossa risorsa dalla raccolta');
        await opts.index.remove(userId, path);
        return;
      }
      const note: BrainNote = {
        ...input,
        path,
        type: resource.kind === 'recipe' ? 'ricetta' : 'immagine',
      };
      const content = serializeNote(note);
      if (old !== content)
        await v.commit([{ path, content }], `Ernie: aggiornata risorsa «${note.title}»`);
      // Ripara anche un precedente commit Git riuscito seguito da un errore dell'indice.
      await opts.index.upsert(userId, note);
      // I collegamenti locali della risorsa sono gia determinati dal sincronizzatore;
      // non ripetere una scansione del vault per ciascuna foto del lotto.
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
      const snapshots = new Map<string, string | null>();
      const existing = await readNote(userId, ref, snapshots);
      if (!existing) return null;
      if (isResourceType(existing.type) || resourceFromPath(existing.path))
        throw managedResourceError();
      const rawBody = (patch.body ?? existing.body).trim();
      const body = existing.knowledge ? renderKnowledgeBody(rawBody, existing.knowledge) : rawBody;
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
        snapshots,
      );
      await opts.index.upsert(userId, note);
      await notifyWritten(userId, [note.path]);
      return service.read(userId, note.path);
    },

    /** Cancella una nota (B3): resta nella cronologia git. False se non esiste. */
    async remove(userId: string, ref: string): Promise<boolean> {
      const existing = await readNote(userId, ref);
      if (!existing) return false;
      if (isResourceType(existing.type) || resourceFromPath(existing.path))
        throw managedResourceError();
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
      const ref = input.into.replace(/\s+/g, ' ').trim().slice(0, 240);
      const target = await readNote(userId, ref);
      if (target && (isResourceType(target.type) || resourceFromPath(target.path)))
        throw managedResourceError();
      const targetTitle = target?.title ?? ref.slice(0, 120);
      const originals = new Map<string, string | null>();
      if (target) originals.set(target.path, await v.read(target.path));
      const sources: BrainNote[] = [];
      const skipped: string[] = [];
      for (const t of input.notes) {
        const n = await readNote(userId, t);
        if (
          !n ||
          isResourceType(n.type) ||
          resourceFromPath(n.path) ||
          n.type === 'chi-sono' ||
          n.type === 'salute' ||
          n.path === target?.path ||
          sources.some((s) => s.path === n.path)
        ) {
          skipped.push(t);
          continue;
        }
        originals.set(n.path, await v.read(n.path));
        sources.push(n);
      }
      if (!sources.length) throw new Error('nessuna nota da unire');
      const structured = [target, ...sources].filter((note): note is BrainNote =>
        Boolean(note?.knowledge),
      );
      const knowledge = structured[0]?.knowledge;
      if (structured.some((note) => JSON.stringify(note.knowledge) !== JSON.stringify(knowledge)))
        throw new BrainKnowledgeError(
          'Le schede hanno dati strutturati diversi: risolvere esplicitamente prima di unirle',
          'knowledge_merge_conflict',
          409,
        );

      const stub = /^Pagina creata da Ernie: compare in \[\[[^\]]*\]\]\.?\s*$/m;
      const base = (
        target
          ? normalizeProfileBlocks(withoutGeneratedQuotes(stripKnowledgeBody(target.body))).replace(
              stub,
              '',
            )
          : `# ${targetTitle}`
      ).replace(/\s+$/, '');
      // Dentro la pagina il rimando a se stessa non serve: «[[Caldaia]]» diventa «Caldaia».
      const selfLink = new RegExp(
        `\\[\\[${targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|([^\\]]*))?\\]\\]`,
        'gi',
      );
      const comparableBase = base.replace(/<!--[\s\S]*?-->/gu, '');
      const sections = sources.flatMap((n) => {
        const text = normalizeProfileBlocks(
          withoutGeneratedQuotes(stripKnowledgeBody(n.body)),
          false,
        )
          .replace(/^#\s+[^\n]*\n?/, '')
          .replace(selfLink, (_m, alias?: string) => alias || targetTitle)
          .trim();
        if (!text || text.split(/\n\s*\n/u).every((p) => comparableBase.includes(p.trim())))
          return [];
        const when = n.refersFrom ?? n.created.slice(0, 10);
        return `## ${n.title} (${italianDate(when)})\n\n${text}`;
      });
      const gone = new Set(sources.map((n) => n.title.toLowerCase()));
      const links = [
        ...new Set([...(target?.links ?? []), ...sources.flatMap((n) => n.links)]),
      ].filter((l) => l.toLowerCase() !== targetTitle.toLowerCase() && !gone.has(l.toLowerCase()));
      const type = target?.type ?? input.type ?? 'argomento';
      let note: BrainNote = target
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
      if (knowledge) note = { ...note, knowledge, body: renderKnowledgeBody(note.body, knowledge) };
      const selfRefs = new Set(
        [
          note.title,
          note.path,
          ...sources.flatMap((n) => [n.title, n.path, n.path.replace(/\.md$/iu, '')]),
        ].map((r) => r.toLowerCase()),
      );
      note = {
        ...note,
        extra: identityExtra(note, sources),
        body: note.body.replace(
          /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu,
          (all, ref: string, alias?: string) =>
            selfRefs.has(ref.toLowerCase()) ? (alias ?? note.title) : all,
        ),
        links: note.links.filter((l) => !selfRefs.has(l.toLowerCase())),
      };
      // Chi citava una nota unita ora cita la pagina: il grafo resta intero (anche in Obsidian).
      const rewritten = new Map<string, BrainNote>();
      const before = new Map<string, string | null>();
      for (const path of await v.list()) before.set(path, await v.read(path));
      // Anche riferimenti con percorso e alias, senza il limite dei primi 100 backlink.
      const refs = new Set(
        sources
          .flatMap((n) => [n.title, n.path, n.path.replace(/\.md$/iu, '')])
          .map((s) => s.toLowerCase()),
      );
      const titles = new Set(sources.map((n) => n.title.toLowerCase()));
      const destination = (ref: string) => (titles.has(ref.toLowerCase()) ? note.title : note.path);
      for (const [path, raw] of before) {
        if (!raw || path === note.path || sources.some((n) => n.path === path)) continue;
        const cur = parseNote(path, raw);
        const rewrite = (text: string) =>
          text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (all, ref: string, alias?: string) =>
            refs.has(ref.toLowerCase())
              ? `[[${destination(ref)}${alias ? `|${alias}` : ''}]]`
              : all,
          );
        let body = rewrite(cur.body);
        // Aggiorna il checksum solo di blocchi integri prima della riscrittura dei link.
        for (const match of cur.body.matchAll(
          /<!-- ernie:(family-profile|consolidated) ([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/ernie:\1 -->/gu,
        )) {
          if (contentHash(match[3] ?? '') !== match[2]) continue;
          const text = rewrite(match[3] ?? '');
          body = body.replace(
            rewrite(match[0]),
            `<!-- ernie:${match[1]} ${contentHash(text)} -->\n${text}\n<!-- /ernie:${match[1]} -->`,
          );
        }
        const links = [
          ...new Set(cur.links.map((l) => (refs.has(l.toLowerCase()) ? destination(l) : l))),
        ];
        if (body !== cur.body || JSON.stringify(links) !== JSON.stringify(cur.links))
          rewritten.set(path, { ...cur, links, body });
      }
      before.set(note.path, target ? (originals.get(target.path) ?? null) : null);
      // I sorgenti letti all'inizio devono essere ancora identici al momento del commit.
      for (const source of sources) before.set(source.path, originals.get(source.path) ?? null);
      const files = [
        { path: note.path, content: serializeNote(note) },
        ...sources.map((n) => ({ path: n.path, content: null })),
        ...[...rewritten.values()].map((n) => ({ path: n.path, content: serializeNote(n) })),
      ];
      await v.commit(files, `Ernie: unite ${sources.length} note in «${note.title}»`, before);
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
