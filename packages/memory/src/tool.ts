import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { MemoryRepository } from './repository.js';

/** Giorno «YYYY-MM-DD» a Roma (i container sono in UTC: tra mezzanotte e le 2 la data UTC è ancora ieri). */
const romeDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);

/** Descrittore per il Policy Engine: legge dati privati, nessun effetto esterno, nessuna scrittura. */
export const MEMORY_SEARCH_POLICY = {
  id: 'memory_search',
  risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
} as const;

/**
 * Tool `memory_search`: la memoria oltre lo snapshot si raggiunge così, senza gonfiare il prefisso.
 * Un'istanza per sessione (legata all'utente), così il set di tool resta stabile.
 */
export function createMemorySearchTool(repo: MemoryRepository, userId: string) {
  return createTool({
    id: 'memory_search',
    description:
      "Cerca nella memoria personale dell'utente: preferenze, abitudini, fatti, relazioni, progetti ed episodi passati. Usalo prima di chiedere qualcosa che l'utente potrebbe aver già detto.",
    inputSchema: z.object({
      query: z.string().min(2).max(300).describe('Cosa cercare, in linguaggio naturale'),
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
        }),
      ),
    }),
    execute: async ({ query, kinds, limit }) => {
      const hits = await repo.search({
        userId,
        query,
        ...(kinds ? { kinds } : {}),
        limit: limit ?? 5,
      });
      return {
        results: hits.map((h) => ({
          content: h.content,
          category: h.category,
          confidence: h.confidence,
          date: romeDate(h.createdAt),
          trusted: h.provenance.trust >= 0.5,
        })),
      };
    },
  });
}
