/**
 * Reciprocal Rank Fusion (k = 60) con pesi opzionali per classifica. Con embeddings di qualità la gamba
 * testuale in OR porta molte corrispondenze deboli: un peso ridotto (misurato: 0,3) evita di diluire i vettori.
 */
export function reciprocalRankFusion(
  rankings: ReadonlyArray<ReadonlyArray<string>>,
  k = 60,
  weights: ReadonlyArray<number> = [],
): Map<string, number> {
  const scores = new Map<string, number>();
  rankings.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + w / (k + i + 1));
    });
  });
  return scores;
}

export function normalizeContent(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
