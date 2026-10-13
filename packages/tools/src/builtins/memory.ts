import type { MemoryRepository } from '@ernie/memory';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

/** Provenienza di un ricordo in parole, per il modello. */
export function sourceLabel(source: string, confidence: number, seenCount: number): string {
  const base =
    source === 'assistant' || source === 'user'
      ? confidence >= 0.85
        ? "detto dall'utente in una conversazione"
        : "dedotto da una conversazione con l'utente"
      : source === 'system'
        ? "registro delle attività svolte con l'utente"
        : `fonte esterna (${source}): da verificare`;
  return seenCount > 1 ? `${base}; confermato ${seenCount} volte` : base;
}

/** `memory_search` come ToolSpec del registry (legge dati privati, nessun effetto esterno). */
export function createMemorySearchSpec(repo: MemoryRepository): ToolSpec {
  return defineTool({
    id: 'memory_search',
    version: '1',
    category: 'memory',
    description:
      "Cerca nella memoria personale dell'utente: preferenze, abitudini, fatti, relazioni, progetti ed episodi passati. Usalo prima di chiedere qualcosa che l'utente potrebbe aver già detto, e quando chiede «perché lo sai?»: ogni risultato dice da dove viene (`source`) e quando è stato annotato.",
    risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
    timeoutMs: 5_000,
    inputSchema: z.object({
      query: z.string().min(2).max(300),
      kinds: z.array(z.enum(['semantic', 'episodic', 'procedural'])).optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          content: z.string(),
          category: z.string().nullable(),
          confidence: z.number(),
          date: z.string(),
          trusted: z.boolean(),
          /** Provenienza in parole (M9 A4): per rispondere a «perché lo sai?». */
          source: z.string(),
        }),
      ),
    }),
    execute: async ({ query, kinds, limit }, ctx) => {
      const hits = await repo.search({
        userId: ctx.userId,
        query,
        ...(kinds ? { kinds } : {}),
        limit: limit ?? 5,
      });
      return {
        results: hits.map((h) => ({
          content: h.content,
          category: h.category,
          confidence: h.confidence,
          date: h.createdAt.toISOString().slice(0, 10),
          trusted: h.provenance.trust >= 0.5,
          source: sourceLabel(h.provenance.source, h.confidence, h.seenCount),
        })),
      };
    },
  });
}
