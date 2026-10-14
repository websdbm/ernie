import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

/**
 * Sentinelle (ricerca 11, C4 + C5): «avvisami quando esce la versione 2.0». Un'automazione ricorrente con
 * controllo economico (se la pagina o il feed non cambiano il modello non viene chiamato) e avviso solo a
 * condizione vera. L'archivio vero sta nelle automazioni; qui c'è solo l'interfaccia per il modello.
 */
export type SentinelFrequency = 'ogni_ora' | 'ogni_giorno' | 'ogni_settimana';

export interface SentinelInfo {
  readonly id: string;
  readonly title: string;
  readonly condition: string;
  readonly schedule: string;
  readonly url: string | null;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  /** Evento unico: dopo il primo avviso la sentinella si ferma da sola. */
  readonly once: boolean;
}

export interface SentinelStore {
  create(
    userId: string,
    s: {
      title: string;
      what: string;
      condition: string;
      url?: string;
      source?: 'pagina' | 'feed';
      frequency: SentinelFrequency;
      time?: string;
      once?: boolean;
    },
  ): Promise<SentinelInfo>;
  list(userId: string): Promise<SentinelInfo[]>;
  remove(userId: string, id: string): Promise<boolean>;
}

const Info = z.object({
  id: z.string(),
  title: z.string(),
  condition: z.string(),
  schedule: z.string(),
  url: z.string().nullable(),
  enabled: z.boolean(),
  pausedReason: z.string().nullable(),
  once: z.boolean(),
});

export function createSentinelTools(store: SentinelStore): ToolSpec[] {
  return [
    defineTool({
      id: 'sentinel_create',
      version: '1',
      category: 'sentinels',
      description:
        "Crea una sentinella: un controllo ricorrente che avvisa l'utente SOLO quando una condizione si avvera (es. «avvisami quando esce la versione 2.0»). Se c'è una pagina o un feed da tenere d'occhio indicalo in url: il modello lavora solo quando cambia. Dopo un avviso la sentinella riscrive solo se c'è una novità rispetto all'ultimo avviso; con once true (evento che accade una volta: «quando esce…», «quando annunciano…», «quando torna disponibile…») si ferma da sola dopo il primo avviso.",
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 5_000,
      inputSchema: z.object({
        title: z.string().min(3).max(80).describe('Titolo breve, es. «Uscita della versione 2.0»'),
        what: z.string().min(5).max(500).describe('Cosa controllare, in una frase'),
        condition: z
          .string()
          .min(3)
          .max(300)
          .describe('Quando avvisare: condizione chiara e verificabile'),
        url: z.url().optional().describe('Pagina o feed da controllare (facoltativo)'),
        source: z.enum(['pagina', 'feed']).optional(),
        frequency: z.enum(['ogni_ora', 'ogni_giorno', 'ogni_settimana']).default('ogni_giorno'),
        time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional()
          .describe('Ora del controllo HH:MM (giornaliero o settimanale), predefinita 09:00'),
        once: z
          .boolean()
          .default(false)
          .describe('Evento unico: true se dopo il primo avviso non serve più controllare'),
      }),
      outputSchema: Info,
      execute: async (input, ctx) => {
        try {
          return await store.create(ctx.userId, {
            title: input.title,
            what: input.what,
            condition: input.condition,
            frequency: input.frequency,
            ...(input.url ? { url: input.url } : {}),
            ...(input.source ? { source: input.source } : {}),
            ...(input.time ? { time: input.time } : {}),
            ...(input.once ? { once: true } : {}),
          });
        } catch (err) {
          throw new ToolError(err instanceof Error ? err.message : String(err), 'invalid');
        }
      },
    }),
    defineTool({
      id: 'sentinel_list',
      version: '1',
      category: 'sentinels',
      description:
        "Elenca le sentinelle dell'utente con condizione, frequenza e stato (attiva, in pausa).",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 5_000,
      inputSchema: z.object({}),
      outputSchema: z.object({ sentinels: z.array(Info) }),
      execute: async (_i, ctx) => ({ sentinels: await store.list(ctx.userId) }),
    }),
    defineTool({
      id: 'sentinel_remove',
      version: '1',
      category: 'sentinels',
      description: 'Toglie una sentinella (id da sentinel_list).',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 5_000,
      inputSchema: z.object({ id: z.uuid() }),
      outputSchema: z.object({ removed: z.boolean() }),
      execute: async ({ id }, ctx) => ({ removed: await store.remove(ctx.userId, id) }),
    }),
  ];
}
