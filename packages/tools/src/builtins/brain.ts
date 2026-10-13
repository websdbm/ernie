import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

/**
 * Second brain (docs/research/12-second-brain.md): note markdown in un repository git per utente, aperto anche
 * con Obsidian. Qui c'è solo l'interfaccia per il modello; vault e indice stanno in @ernie/brain.
 */
export const BRAIN_NOTE_TYPES = [
  'nota',
  'documento',
  'persona',
  'luogo',
  'progetto',
  'argomento',
] as const;

export interface BrainToolHit {
  readonly title: string;
  readonly path: string;
  readonly type: string;
  readonly created: string;
  readonly refersFrom: string | null;
  readonly refersTo: string | null;
  readonly place: string | null;
  readonly links: readonly string[];
  readonly private: boolean;
  readonly passage: string;
}

export interface BrainToolStore {
  search(
    userId: string,
    q: {
      query?: string;
      type?: (typeof BRAIN_NOTE_TYPES)[number];
      from?: string;
      to?: string;
      place?: string;
      near?: readonly [number, number];
      radiusKm?: number;
      linkedTo?: string;
      includePrivate?: boolean;
      limit?: number;
    },
  ): Promise<BrainToolHit[]>;
  read(
    userId: string,
    ref: string,
  ): Promise<{
    title: string;
    path: string;
    type: string;
    created: string;
    refersFrom: string | null;
    refersTo: string | null;
    place: string | null;
    links: readonly string[];
    backlinks: readonly string[];
    private: boolean;
    body: string;
  } | null>;
  write(
    userId: string,
    input: {
      title: string;
      body: string;
      type?: (typeof BRAIN_NOTE_TYPES)[number];
      mode?: 'create' | 'append' | 'replace';
      refersFrom?: string;
      refersTo?: string;
      place?: string;
      coords?: readonly [number, number];
      links?: readonly string[];
      private?: boolean;
      source?: 'chat' | 'voce';
    },
  ): Promise<{ path: string; title: string; created: boolean; links: readonly string[] }>;
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');

export function createBrainTools(store: BrainToolStore): ToolSpec[] {
  return [
    defineTool({
      id: 'brain_search',
      version: '1',
      category: 'brain',
      description:
        "Cerca nel second brain dell'utente (le sue note, documenti, pagine su persone, luoghi, progetti). Filtri facoltativi: periodo a cui si riferiscono (from/to), luogo per nome o vicino alla posizione attuale (nearMe), tipo, note collegate a una pagina (linkedTo). Le note riservate restano escluse salvo includePrivate, da usare SOLO se l'utente lo chiede esplicitamente.",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({
        query: z
          .string()
          .max(300)
          .optional()
          .describe('Parole o domanda; vuoto per elencare con i soli filtri'),
        type: z.enum(BRAIN_NOTE_TYPES).optional(),
        from: day.optional(),
        to: day.optional(),
        place: z.string().max(80).optional().describe('Nome del luogo (es. «Verona»)'),
        nearMe: z.boolean().optional().describe('Solo note annotate vicino a dove si trova adesso'),
        linkedTo: z
          .string()
          .max(120)
          .optional()
          .describe('Titolo di una pagina: note collegate a lei'),
        includePrivate: z.boolean().optional(),
        limit: z.number().int().min(1).max(15).optional(),
      }),
      outputSchema: z.object({
        notes: z.array(
          z.object({
            title: z.string(),
            type: z.string(),
            date: z.string(),
            place: z.string().nullable(),
            links: z.array(z.string()),
            private: z.boolean(),
            passage: z.string(),
          }),
        ),
      }),
      execute: async (input, ctx) => {
        const here = ctx.device?.location;
        if (input.nearMe && !here)
          throw new ToolError(
            'posizione del telefono non disponibile: chiedi il luogo per nome',
            'invalid',
          );
        const hits = await store.search(ctx.userId, {
          ...(input.query ? { query: input.query } : {}),
          ...(input.type ? { type: input.type } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          ...(input.place ? { place: input.place } : {}),
          ...(input.nearMe && here
            ? { near: [here.latitude, here.longitude] as const, radiusKm: 3 }
            : {}),
          ...(input.linkedTo ? { linkedTo: input.linkedTo } : {}),
          ...(input.includePrivate ? { includePrivate: true } : {}),
          limit: input.limit ?? 6,
        });
        return {
          notes: hits.map((h) => ({
            title: h.title,
            type: h.type,
            date: h.refersFrom
              ? `${h.refersFrom}${h.refersTo ? ` → ${h.refersTo}` : ''}`
              : h.created.slice(0, 10),
            place: h.place,
            links: [...h.links],
            private: h.private,
            passage: h.passage.slice(0, 700),
          })),
        };
      },
    }),
    defineTool({
      id: 'brain_read',
      version: '1',
      category: 'brain',
      description:
        'Legge una nota del second brain per titolo (anche una pagina «Chi sono», una persona o un luogo), con le note che la richiamano.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({ title: z.string().min(1).max(160) }),
      outputSchema: z.object({
        found: z.boolean(),
        title: z.string().optional(),
        type: z.string().optional(),
        date: z.string().optional(),
        place: z.string().nullable().optional(),
        links: z.array(z.string()).optional(),
        backlinks: z.array(z.string()).optional(),
        private: z.boolean().optional(),
        text: z.string().optional(),
      }),
      execute: async ({ title }, ctx) => {
        const n = await store.read(ctx.userId, title);
        if (!n) return { found: false };
        return {
          found: true,
          title: n.title,
          type: n.type,
          date: n.refersFrom ?? n.created.slice(0, 10),
          place: n.place,
          links: [...n.links],
          backlinks: [...n.backlinks],
          private: n.private,
          text: n.body.length > 8000 ? `${n.body.slice(0, 8000)}…` : n.body,
        };
      },
    }),
    defineTool({
      id: 'brain_write',
      version: '1',
      category: 'brain',
      description:
        "Scrive nel second brain dell'utente: crea una nota o una pagina (persona, luogo, progetto, argomento), aggiunge in fondo a una esistente (mode append) o la riscrive (mode replace). Collega persone, luoghi, progetti e argomenti scrivendo [[Titolo]] nel testo o in links. Se la nota nasce dove si trova l'utente, lascia hereAndNow attivo: luogo e coordinate vengono dal telefono. Ogni modifica resta nella cronologia ed è annullabile.",
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 60_000,
      inputSchema: z.object({
        title: z
          .string()
          .min(2)
          .max(120)
          .describe('Titolo breve e specifico, es. «Codice della caldaia»'),
        body: z.string().min(1).max(60_000).describe('Testo markdown; collegamenti con [[Titolo]]'),
        type: z.enum(BRAIN_NOTE_TYPES).optional(),
        mode: z.enum(['create', 'append', 'replace']).optional(),
        refersFrom: day.optional().describe('Giorno a cui si riferisce (evento, scadenza)'),
        refersTo: day.optional(),
        place: z
          .string()
          .max(80)
          .optional()
          .describe('Luogo a cui si riferisce, se diverso da dove si trova'),
        hereAndNow: z
          .boolean()
          .optional()
          .describe('Usa la posizione attuale del telefono (predefinito sì)'),
        links: z.array(z.string().max(120)).max(20).optional(),
        private: z
          .boolean()
          .optional()
          .describe('Nota riservata (salute, soldi, documenti personali)'),
        spoken: z.boolean().optional().describe("true se l'utente l'ha dettata a voce"),
      }),
      outputSchema: z.object({
        title: z.string(),
        created: z.boolean(),
        links: z.array(z.string()),
      }),
      execute: async (input, ctx) => {
        const here = input.hereAndNow === false ? undefined : ctx.device?.location;
        const r = await store.write(ctx.userId, {
          title: input.title,
          body: input.body,
          ...(input.type ? { type: input.type } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.refersFrom ? { refersFrom: input.refersFrom } : {}),
          ...(input.refersTo ? { refersTo: input.refersTo } : {}),
          ...(input.place ? { place: input.place } : here?.place ? { place: here.place } : {}),
          ...(here && !input.place ? { coords: [here.latitude, here.longitude] as const } : {}),
          ...(input.links ? { links: input.links } : {}),
          ...(input.private !== undefined ? { private: input.private } : {}),
          source: input.spoken ? 'voce' : 'chat',
        });
        return { title: r.title, created: r.created, links: [...r.links] };
      },
    }),
  ];
}
