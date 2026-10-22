import { mergedIdentities } from './identities.js';
import type { BrainNote } from './note.js';

export interface BrainOverview {
  readonly facts: ReadonlyArray<{
    text: string;
    sourcePath: string;
    sourceTitle: string;
    date: string | null;
  }>;
  readonly places: ReadonlyArray<{
    path: string;
    title: string;
    address: string | null;
    coords: readonly [number, number] | null;
  }>;
}

const DATE =
  /(?:\d{4}-\d{2}-\d{2}|\d{1,2} (?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre) \d{4})/iu;
const key = (s: string) =>
  s
    .toLocaleLowerCase('it')
    .replace(/\s+/gu, ' ')
    .replace(/[.;]+$/u, '')
    .trim();

/** Only whole, unambiguous field formulations are normalized; differing values stay visible. */
function fieldText(s: string): string {
  const shoe =
    /^(?:porta il|numero di scarpe:?)\s*(\d{2}(?:[.,]\d+)?)\s*(?:di scarpe)?[.]?$/iu.exec(s);
  return shoe ? `Numero di scarpe: ${shoe[1]}` : s;
}

/** Read-only, lossless source remains in body/history. No model, no inferred residence or address. */
export function buildBrainOverview(
  note: BrainNote,
  linked: readonly BrainNote[],
): BrainOverview | null {
  if (note.type !== 'persona' && note.type !== 'luogo') return null;
  const places = [
    ...new Map(
      [note, ...linked]
        .filter((n) => n.type === 'luogo' && (n.path === note.path || !n.private))
        .map((n) => [
          n.path,
          {
            path: n.path,
            title: n.title,
            address: n.place ?? null,
            coords: n.coords ?? null,
          },
        ]),
    ).values(),
  ];
  const identities = new Set([note.title, ...mergedIdentities(note).map((a) => a.title)].map(key));
  const facts: Array<BrainOverview['facts'][number]> = [];
  const seen = new Set<string>();
  let date: string | null = null;
  let sourcePath = note.path;
  let sourceTitle = note.title;
  let context = '';
  let block: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const raw = block.join('\n').trim();
    block = [];
    if (
      !raw ||
      /^(?:Uno dei luoghi della tua scheda|Con Ernie:|Pagina creata da Ernie:|_Generata)/u.test(raw)
    )
      return;
    // Place details have dedicated cards, instead of repeating generated address quotations.
    if (
      sourcePath !== note.path &&
      places.some((p) => p.path === sourcePath && p.address && key(p.address) === key(raw))
    )
      return;
    const text = fieldText(raw.replace(/^[-*+]\s+/u, ''));
    const display = context ? `**${context}**\n${text}` : text;
    const identity = key(display);
    if (seen.has(identity)) return;
    seen.add(identity);
    facts.push({ text: display, sourcePath, sourceTitle, date });
  };
  for (const line of note.body.replace(/<!--[\s\S]*?-->/gu, '').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        flush();
        fence = marker;
      } else if (marker.startsWith(fence[0] ?? '`') && marker.length >= fence.length) fence = null;
      block.push(line);
      if (!fence) flush();
      continue;
    }
    if (fence) {
      block.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/u.exec(line)?.[1]?.trim();
    if (heading) {
      flush();
      if (key(heading) === key(note.title)) continue;
      if (heading === 'Informazioni collegate') {
        context = '';
        continue;
      }
      const citation = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/u.exec(heading);
      if (citation) {
        sourcePath = citation[1] ?? note.path;
        sourceTitle =
          citation[2] ?? sourcePath.replace(/\.md$/u, '').split('/').pop() ?? sourcePath;
        context = '';
      } else {
        sourcePath = note.path;
        sourceTitle = note.title;
      }
      const dateMatch = heading.match(DATE)?.[0];
      date = dateMatch ?? null;
      // Dated entries and merge headings are history labels, not facts.
      const label = dateMatch
        ? heading.replace(dateMatch, '').replace(/[()·]/gu, '').trim()
        : heading;
      context = citation || identities.has(key(label)) ? '' : label;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const clean = line.replace(/^>\s?/u, '');
    if (/^[-*+]\s/u.test(clean)) flush();
    block.push(clean);
  }
  flush();
  return { facts, places };
}
