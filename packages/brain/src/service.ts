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
}

export interface WriteResult {
  readonly path: string;
  readonly title: string;
  readonly created: boolean;
  readonly links: readonly string[];
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
}

export interface ChiSonoInput extends ChiSonoFields {
  readonly family: ReadonlyArray<{
    readonly name?: string | null;
    readonly relation: string;
    readonly birthDate?: string | null;
    readonly notes?: string | null;
  }>;
}

const CHI_SONO_KEYS: Array<[keyof ChiSonoFields, string]> = [
  ['fullName', 'nome'],
  ['preferredName', 'chiamami'],
  ['birthDate', 'nascita'],
  ['gender', 'genere'],
  ['city', 'citta'],
  ['occupation', 'lavoro'],
];

const ERNIE_AUTHOR = 'Ernie';

const today = () =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long' }).format(
    new Date(),
  );

const nowIso = () => new Date().toISOString().slice(0, 16);

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
      const existing = await readNote(userId, title);
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
      const verb = created ? 'nuova nota' : mode === 'replace' ? 'riscritta' : 'aggiunto a';
      await v.commit(
        [{ path: note.path, content: serializeNote(note) }],
        `Ernie: ${verb} «${title}»`,
      );
      await opts.index.upsert(userId, note);
      return { path: note.path, title: note.title, created, links: all };
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

    async list(userId: string, q: BrainQuery = {}): Promise<NoteSummary[]> {
      await ready(userId);
      return opts.index.list(userId, q);
    },

    /** Pagina «Chi sono» dalla scheda anagrafica, con le pagine-persona dei familiari (create se mancano). */
    async writeChiSono(userId: string, p: ChiSonoInput): Promise<void> {
      await ready(userId);
      const v = vault(userId);
      const files: Array<{ path: string; content: string }> = [];
      const family = p.family.map((m) => {
        const name = m.name?.trim();
        const extra = [m.birthDate ? `nascita ${m.birthDate}` : null, m.notes ?? null]
          .filter(Boolean)
          .join(', ');
        return `- ${name ? `[[${name}]]` : m.relation}${name ? ` (${m.relation})` : ''}${extra ? `, ${extra}` : ''}`;
      });
      const body = [
        '# Chi sono',
        '',
        'Pagina generata dalla scheda anagrafica di Ernie. I campi qui sopra (nome, chiamami, nascita, genere, citta, lavoro) si possono modificare anche da qui; la famiglia si modifica nell’app, in Impostazioni › La tua scheda.',
        '',
        ...(family.length ? ['## Famiglia', '', ...family] : []),
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
      if (old === files[0]?.content && files.length === 1) return;
      await v.commit(files, 'Ernie: aggiornata «Chi sono» dalla scheda');
      for (const f of files) await opts.index.upsert(userId, parseNote(f.path, f.content));
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
