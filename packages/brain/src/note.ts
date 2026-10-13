/**
 * Note del second brain (docs/research/12-second-brain.md): file markdown con frontmatter YAML compatibile con
 * Obsidian. Il frontmatter è un sottoinsieme semplice (valori, elenchi, coordinate); le chiavi sconosciute e le
 * righe che non si capiscono restano intatte, così le modifiche fatte in Obsidian non si perdono.
 */

export const NOTE_TYPES = [
  'nota',
  'documento',
  'persona',
  'luogo',
  'progetto',
  'argomento',
  'chi-sono',
  'salute',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const FOLDERS: Record<NoteType, string> = {
  nota: 'Note',
  documento: 'Documenti',
  persona: 'Persone',
  luogo: 'Luoghi',
  progetto: 'Progetti',
  argomento: 'Argomenti',
  'chi-sono': '',
  salute: 'Salute',
};

export type NoteSource = 'chat' | 'voce' | 'foto' | 'pdf' | 'memoria' | 'obsidian' | 'scheda';

export interface BrainNote {
  /** Percorso relativo nel vault, es. «Note/Codice della caldaia.md». */
  readonly path: string;
  readonly title: string;
  readonly type: NoteType;
  /** Quando è nata (ISO 8601). */
  readonly created: string;
  /** A quando si riferisce: «YYYY-MM-DD» oppure intervallo. */
  readonly refersFrom?: string;
  readonly refersTo?: string;
  readonly place?: string;
  readonly coords?: readonly [number, number];
  /** Titoli delle note collegate (frontmatter + `[[…]]` nel testo). */
  readonly links: readonly string[];
  readonly private: boolean;
  readonly source?: NoteSource;
  readonly body: string;
  /** Righe del frontmatter non gestite (preservate alla riscrittura). */
  readonly extra?: readonly string[];
}

const KNOWN = new Set([
  'tipo',
  'creata',
  'riguarda',
  'fino',
  'luogo',
  'coordinate',
  'collegamenti',
  'riservata',
  'fonte',
  'titolo',
]);

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1).replace(/\\"/g, '"');
  return t;
};

function inlineList(v: string): string[] {
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return [];
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of t.slice(1, -1)) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(unquote(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(unquote(cur));
  return out;
}

const linkName = (s: string) =>
  s
    .replace(/^\[\[|\]\]$/g, '')
    .split('|')[0]
    ?.split('#')[0]
    ?.trim() ?? '';

/** Collegamenti `[[Titolo]]`, `[[Titolo|alias]]`, `[[Titolo#sezione]]` nel testo. */
export function bodyLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const name = linkName(m[1] ?? '');
    if (name) out.add(name);
  }
  return [...out];
}

export const titleFromPath = (path: string) => path.split('/').pop()?.replace(/\.md$/i, '') ?? path;

const isType = (v: string): v is NoteType => (NOTE_TYPES as readonly string[]).includes(v);

/** Legge una nota. Senza frontmatter è una nota semplice con il titolo dal nome del file. */
export function parseNote(path: string, text: string, fallbackCreated = new Date()): BrainNote {
  const src = text.replace(/\r\n/g, '\n');
  let front: string[] = [];
  let body = src;
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4);
    if (end > 0) {
      front = src.slice(4, end).split('\n');
      body = src.slice(end + 4).replace(/^\n/, '');
    }
  }
  const fields = new Map<string, string | string[]>();
  const extra: string[] = [];
  for (let i = 0; i < front.length; i++) {
    const line = front[i] ?? '';
    const m = /^([A-Za-zÀ-ÿ_][\wÀ-ÿ-]*):\s*(.*)$/.exec(line);
    if (!m) {
      if (line.trim()) extra.push(line);
      continue;
    }
    const key = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? '';
    if (!KNOWN.has(key)) {
      extra.push(line);
      // Le righe di un elenco a blocchi di una chiave sconosciuta seguono la chiave.
      while (i + 1 < front.length && /^\s+-\s/.test(front[i + 1] ?? ''))
        extra.push(front[++i] ?? '');
      continue;
    }
    if (value.trim() === '') {
      const items: string[] = [];
      while (i + 1 < front.length && /^\s+-\s/.test(front[i + 1] ?? ''))
        items.push(unquote((front[++i] ?? '').replace(/^\s+-\s/, '')));
      fields.set(key, items);
    } else if (value.trim().startsWith('[')) {
      fields.set(key, inlineList(value));
    } else {
      fields.set(key, unquote(value));
    }
  }
  const str = (k: string) => {
    const v = fields.get(k);
    return typeof v === 'string' && v ? v : undefined;
  };
  const list = (k: string) => {
    const v = fields.get(k);
    return Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
  };
  const coordsRaw = list('coordinate').map(Number);
  const coords =
    coordsRaw.length === 2 &&
    coordsRaw.every((n) => Number.isFinite(n)) &&
    Math.abs(coordsRaw[0] ?? 0) <= 90 &&
    Math.abs(coordsRaw[1] ?? 0) <= 180
      ? ([coordsRaw[0], coordsRaw[1]] as [number, number])
      : undefined;
  const typeRaw = str('tipo') ?? (path === 'Chi sono.md' ? 'chi-sono' : 'nota');
  const links = new Set([
    ...list('collegamenti').map(linkName).filter(Boolean),
    ...bodyLinks(body),
  ]);
  const source = str('fonte') as NoteSource | undefined;
  const riferimento = str('riguarda');
  const fino = str('fino');
  const luogo = str('luogo');
  return {
    path,
    title: str('titolo') ?? titleFromPath(path),
    type: isType(typeRaw) ? typeRaw : 'nota',
    created: str('creata') ?? fallbackCreated.toISOString(),
    ...(riferimento ? { refersFrom: riferimento } : {}),
    ...(fino ? { refersTo: fino } : {}),
    ...(luogo ? { place: luogo } : {}),
    ...(coords ? { coords } : {}),
    links: [...links],
    private: /^(true|sì|si|yes)$/i.test(str('riservata') ?? ''),
    ...(source ? { source } : {}),
    body: body.replace(/\s+$/, ''),
    ...(extra.length ? { extra } : {}),
  };
}

const q = (v: string) =>
  /^[\w À-ÿ.,'’()-]+$/u.test(v) && !/^(true|false|\d)/.test(v) ? v : JSON.stringify(v);

/** Scrive una nota con frontmatter leggibile da Obsidian. */
export function serializeNote(n: BrainNote): string {
  const lines = ['---', `tipo: ${n.type}`, `creata: ${n.created}`];
  if (n.refersFrom) lines.push(`riguarda: ${n.refersFrom}`);
  if (n.refersTo) lines.push(`fino: ${n.refersTo}`);
  if (n.place) lines.push(`luogo: ${q(n.place)}`);
  if (n.coords) lines.push(`coordinate: [${n.coords[0].toFixed(4)}, ${n.coords[1].toFixed(4)}]`);
  const frontLinks = n.links.filter((l) => !bodyLinks(n.body).includes(l));
  if (frontLinks.length) {
    lines.push('collegamenti:');
    for (const l of frontLinks) lines.push(`  - "[[${l}]]"`);
  }
  if (n.private) lines.push('riservata: true');
  if (n.source) lines.push(`fonte: ${n.source}`);
  for (const e of n.extra ?? []) lines.push(e);
  lines.push('---', '');
  return `${lines.join('\n')}${n.body.replace(/\s+$/, '')}\n`;
}

/** Nome di file sicuro (anche per Obsidian e git) dal titolo. */
export function safeFileName(title: string): string {
  const t = title
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
    .replace(/[. ]+$/, '');
  return t || 'Senza titolo';
}

export function pathFor(type: NoteType, title: string): string {
  if (type === 'chi-sono') return 'Chi sono.md';
  return `${FOLDERS[type]}/${safeFileName(title)}.md`;
}

/** Data valida «YYYY-MM-DD» (o null). */
export function isoDay(v: string | null | undefined): string | undefined {
  const t = (v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? undefined : t;
}
