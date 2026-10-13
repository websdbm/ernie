import type { ChunkHit } from './chunks.js';

/**
 * Citazioni verificate (ricerca 11, S2): nella scheda «Fonti» finiscono solo le pagine che la risposta cita
 * («(p. 42)», «pag. 42», «pagine 34-35») E che compaiono tra i passaggi restituiti dal tool nel turno.
 * Una pagina inventata dal modello non diventa mai una fonte.
 */
export interface Citation {
  readonly documentId: string;
  readonly title: string;
  readonly page: number;
  readonly heading: string | null;
  readonly excerpt: string;
}

export function citedPages(text: string): number[] {
  const pages: number[] = [];
  for (const m of text.matchAll(
    /\b(?:p|pp|pag|pagg|pagina|pagine)\.?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/giu,
  )) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = a; p <= Math.min(b, a + 10); p++) pages.push(p);
  }
  return [...new Set(pages)];
}

export function verifiedCitations(
  text: string,
  passages: readonly ChunkHit[],
  max = 6,
): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const page of citedPages(text)) {
    const hit = passages.find((p) => p.page === page);
    if (!hit) continue;
    const key = `${hit.documentId}:${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId: hit.documentId,
      title: hit.title,
      page,
      heading: hit.heading,
      excerpt: hit.content.slice(0, 400),
    });
    if (out.length >= max) break;
  }
  return out;
}
