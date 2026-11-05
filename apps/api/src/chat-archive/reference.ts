import type { Archive, ChatArchiveRepository } from './types.js';

const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const STOP = new Set([
  'nella',
  'della',
  'delle',
  'dalla',
  'chat',
  'conversazione',
  'archivio',
  'archiviata',
  'whatsapp',
  'cosa',
  'abbiamo',
  'detto',
  'scritto',
  'quale',
  'quando',
  'come',
  'puoi',
  'cerca',
  'cercare',
  'leggi',
  'fammi',
  'riassunto',
  'gruppo',
]);
/** Metadata-only lookup: no message retrieval, model call, ambient memory or transcript write. */
export async function resolveArchiveReference(
  repo: ChatArchiveRepository,
  userId: string,
  request: string,
) {
  const rows: Archive[] = [];
  let total = 0;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await repo.list(userId, { offset, limit: 100 });
    rows.push(...page.archives);
    total = page.total;
    if (rows.length >= total || !page.archives.length) break;
  }
  const normalized = ` ${words(request)} `;
  const mentioned = rows.filter((a) => {
    const name = words(a.name);
    return name.length >= 3 && normalized.includes(` ${name} `);
  });
  const terms = new Set(
    words(request)
      .split(' ')
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );
  const score = (a: Archive) => {
    const name = new Set(words(a.name).split(' '));
    const meta = new Set(
      words([a.summary ?? '', a.category ?? '', ...a.tags].join(' ')).split(' '),
    );
    return Array.from(terms).reduce((n, t) => n + (name.has(t) ? 4 : meta.has(t) ? 1 : 0), 0);
  };
  const candidates = mentioned.length ? mentioned : [...rows].sort((a, b) => score(b) - score(a));
  // Never select when an omitted page could contain an equally named conversation.
  const selectedArchiveId =
    mentioned.length === 1 && rows.length >= total ? (mentioned[0]?.id ?? null) : null;
  return { archives: candidates.slice(0, 30), total, selectedArchiveId, question: request };
}
