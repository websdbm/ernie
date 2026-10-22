import type { MemoryRepository } from '@ernie/memory';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

/** Giorno «YYYY-MM-DD» a Roma (i container sono in UTC: tra mezzanotte e le 2 la data UTC è ancora ieri). */
const romeDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);

/** Provenienza di un ricordo in parole, per il modello. */
export function sourceLabel(source: string, _confidence: number, seenCount: number): string {
  const base =
    source === 'user'
      ? "registrato da una conversazione con l'utente; verificare la fonte prima di citarlo come dichiarazione testuale"
      : source === 'assistant'
        ? "derivato dalla conversazione, non una dichiarazione testuale dell'utente"
        : source === 'system'
          ? "registro delle attività svolte con l'utente"
          : `fonte esterna (${source}): da verificare`;
  return seenCount > 1
    ? `${base}; registrato ${seenCount} volte (ripetizione, non conferma indipendente)`
    : base;
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
          status: z.string(),
          validFrom: z.string(),
          validTo: z.string().nullable(),
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
      if (hits.some((hit) => hit.provenance.trust < 0.5)) {
        ctx.run.markUntrusted('memory_search:external-provenance');
      }
      return {
        results: hits.map((h) => ({
          content: h.content,
          category: h.category,
          confidence: h.confidence,
          date: romeDate(h.createdAt),
          trusted: h.provenance.trust >= 0.5,
          source: sourceLabel(h.provenance.source, h.confidence, h.seenCount),
          status: h.status,
          validFrom: h.validFrom.toISOString(),
          validTo: h.validTo?.toISOString() ?? null,
        })),
      };
    },
  });
}
