/** Offsets are UTF-16 character positions in the cleaned page, not the original HTML. */
export interface WebPassageRange {
  readonly start: number;
  readonly end: number;
  readonly heading: string | null;
}

export interface WebContentSelection {
  readonly content: string;
  readonly coverage: {
    readonly totalChars: number;
    readonly availableChars: number;
    readonly returnedChars: number;
    readonly truncated: boolean;
    readonly storageTruncated: boolean;
    readonly selection: 'full' | 'relevant' | 'start' | 'offset';
    readonly ranges: readonly WebPassageRange[];
    readonly nextOffset: number | null;
  };
}

/** Cleaning is deterministic and never turns page text into trusted instructions. */
export function sanitizeWebContent(markdown: string, maxChars: number): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string) => text)
    .replace(/(\?|&)(utm_[a-z]+|fbclid|gclid)=[^&\s)]+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

const stopWords = new Set(
  'a al alla alle allo anche che chi ci come con cosa da dal dalla dalle dei del della delle di e è gli ha i il in la le lo ma nel nella nelle non o per più quale quali quando quanto se si sono su sul sulla tra un una uno the a an and are as at be by can do for from how in is it of on or that this to was what when where which who with'.split(
    ' ',
  ),
);
const normalized = (text: string) => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const termsOf = (text: string) => normalized(text).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];

/** Select bounded, non-overlapping passages; rank locally without another model call. */
export function selectWebContent(
  text: string,
  options: {
    maxChars: number;
    query?: string | undefined;
    offset?: number | undefined;
    totalChars?: number | undefined;
  },
): WebContentSelection {
  const totalChars = Math.max(text.length, options.totalChars ?? text.length);
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const offset = Math.min(text.length, Math.max(0, Math.floor(options.offset ?? 0)));
  const headings: Array<{ start: number; title: string }> = [];
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    headings.push({ start: match.index, title: (match[1] ?? '').slice(0, 160) });
  }
  function range(start: number, end: number): WebPassageRange {
    let heading: string | null = null;
    for (const candidate of headings) {
      if (candidate.start > start) break;
      heading = candidate.title;
    }
    return { start, end, heading };
  }
  const queryTerms = new Set(
    termsOf(options.query ?? '').filter((term) => term.length > 1 && !stopWords.has(term)),
  );
  let selection: WebContentSelection['coverage']['selection'] =
    options.offset === undefined ? 'start' : 'offset';
  let ranges: WebPassageRange[] = [];
  const separator = '\n\n[…]\n\n';
  if (options.offset === undefined && text.length <= maxChars) {
    selection = 'full';
    if (text.length) ranges = [range(0, text.length)];
  } else if (options.offset === undefined && queryTerms.size && maxChars > 0) {
    // Paragraphs/headings are preferred boundaries. Long paragraphs are split, so a
    // match near the bottom of a huge paragraph is not lost behind its first words.
    const chunks: Array<WebPassageRange & { score: number }> = [];
    const chunkSize = Math.min(900, maxChars);
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + chunkSize);
      if (end < text.length) {
        const paragraph = text.lastIndexOf('\n\n', end);
        const word = text.lastIndexOf(' ', end);
        if (paragraph > start + chunkSize / 2) end = paragraph + 2;
        else if (word > start + chunkSize / 2) end = word + 1;
      }
      const passage = range(start, end);
      const terms = new Set(termsOf(text.slice(start, end)));
      const headingTerms = new Set(termsOf(passage.heading ?? ''));
      let score = 0;
      for (const term of queryTerms) {
        if (terms.has(term)) score += 3;
        if (headingTerms.has(term)) score += 1;
      }
      chunks.push({ ...passage, score });
      start = end;
    }
    const ranked = chunks
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score || a.start - b.start);
    let remaining = maxChars;
    for (const chunk of ranked) {
      const separatorCost = ranges.length ? separator.length : 0;
      if (remaining <= separatorCost || ranges.length === 4) break;
      const length = Math.min(chunk.end - chunk.start, remaining - separatorCost);
      ranges.push(range(chunk.start, chunk.start + length));
      remaining -= length + separatorCost;
    }
    if (ranges.length) {
      ranges.sort((a, b) => a.start - b.start);
      selection = 'relevant';
    }
  }
  if (!ranges.length && offset < text.length && maxChars > 0) {
    ranges = [range(offset, Math.min(text.length, offset + maxChars))];
  }
  const content = ranges.map((part) => text.slice(part.start, part.end)).join(separator);
  // For relevance mode, point to the first omitted span, not simply after the
  // final excerpt (which could hide omitted introductions or intervening sections).
  let cursor = options.offset === undefined ? 0 : offset;
  for (const part of ranges) {
    if (part.start > cursor) break;
    cursor = Math.max(cursor, part.end);
  }
  const selectedChars = ranges.reduce((sum, part) => sum + part.end - part.start, 0);
  return {
    content,
    coverage: {
      totalChars,
      availableChars: text.length,
      returnedChars: content.length,
      truncated: selectedChars < totalChars,
      storageTruncated: totalChars > text.length,
      selection,
      ranges,
      nextOffset: cursor < text.length ? cursor : null,
    },
  };
}

/** Short-lived process memory only: no disk, no shared cross-account cache. */
export class ScopedWebCache<T> {
  private readonly entries = new Map<
    string,
    { userId: string; expires: number; weight: number; value: T }
  >();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 96,
    private readonly maxEntriesPerUser = 12,
    private readonly maxChars = 4_000_000,
  ) {}

  private purge() {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }

  get(userId: string, key: string): T | undefined {
    this.purge();
    const scopedKey = JSON.stringify([userId, key]);
    const entry = this.entries.get(scopedKey);
    if (!entry) return undefined;
    this.entries.delete(scopedKey);
    this.entries.set(scopedKey, entry);
    return entry.value;
  }

  set(userId: string, key: string, value: T, weight: number): void {
    this.purge();
    if (this.ttlMs <= 0 || weight > this.maxChars) return;
    const scopedKey = JSON.stringify([userId, key]);
    this.entries.delete(scopedKey);
    this.entries.set(scopedKey, { userId, expires: Date.now() + this.ttlMs, value, weight });
    let userCount = [...this.entries.values()].filter((entry) => entry.userId === userId).length;
    for (const [oldKey, entry] of this.entries) {
      if (userCount <= this.maxEntriesPerUser) break;
      if (entry.userId === userId) {
        this.entries.delete(oldKey);
        userCount--;
      }
    }
    let totalWeight = [...this.entries.values()].reduce((sum, entry) => sum + entry.weight, 0);
    for (const [oldKey, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && totalWeight <= this.maxChars) break;
      this.entries.delete(oldKey);
      totalWeight -= entry.weight;
    }
  }
}
