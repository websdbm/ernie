import type { BrainNote } from './note.js';
import { contentHash, managedContent } from './reconcile.js';

export interface MergedIdentity {
  title: string;
  path: string;
}
const FIELD = 'ernie_unioni:';
/** Scritto nello stesso commit della fusione: sopravvive anche a un arresto prima del salvataggio SQL. */
export function mergedIdentities(note: BrainNote): MergedIdentity[] {
  try {
    const raw: unknown = JSON.parse(
      note.extra?.find((l) => l.startsWith(FIELD))?.slice(FIELD.length) ?? '[]',
    );
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (v): v is MergedIdentity =>
        v &&
        typeof v.title === 'string' &&
        typeof v.path === 'string' &&
        v.title.length <= 120 &&
        v.path.endsWith('.md'),
    );
  } catch {
    return [];
  }
}
export function identityExtra(note: BrainNote, sources: readonly BrainNote[]): string[] {
  const aliases = [
    ...mergedIdentities(note),
    ...sources.flatMap((n) => [{ title: n.title, path: n.path }, ...mergedIdentities(n)]),
  ];
  return [
    ...(note.extra ?? []).filter((l) => !l.startsWith(FIELD)),
    `${FIELD} ${JSON.stringify([...new Map(aliases.filter((a) => a.path !== note.path).map((a) => [a.path, a])).values()])}`,
  ];
}
/** Togli solo citazioni rigenerabili integre. Una modifica manuale resta contenuto autorevole. */
export function withoutGeneratedQuotes(body: string): string {
  const managed = managedContent(body);
  return managed.edited ? body : managed.base;
}
/** I blocchi anagrafici importati diventano testo: solo il primo resta sincronizzato. */
export function normalizeProfileBlocks(body: string, keepFirst = true): string {
  const seen = new Set<string>();
  let kept = false;
  return body.replace(
    /<!-- ernie:family-profile ([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/ernie:family-profile -->/gu,
    (all, hash: string, text: string) => {
      if (contentHash(text) !== hash) return all;
      const paragraphs = text.split(/\n\s*\n/u);
      if (keepFirst && !kept) {
        kept = true;
        for (const p of paragraphs) seen.add(p.trim());
        return all;
      }
      return paragraphs
        .filter((p) => {
          const k = p.trim();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .join('\n\n');
    },
  );
}
