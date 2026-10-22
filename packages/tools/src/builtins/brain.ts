import {
  BrainAgendaSchema,
  BrainDate,
  BrainKnowledgeSchema,
  type BrainKnowledgeUpdate,
  BrainKnowledgeUpdateSchema,
  BrainTimeZone,
  brainLocalDay,
} from '@ernie/protocol';
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
      type?: (typeof BRAIN_NOTE_TYPES)[number] | 'ricetta' | 'immagine';
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
    knowledge?: unknown;
  } | null>;
  updateKnowledge?(
    userId: string,
    input: BrainKnowledgeUpdate,
  ): Promise<{ path: string; title: string; knowledge: unknown }>;
  agenda?(
    userId: string,
    input: { date: string; timeZone: string; ref?: string; includePrivate?: boolean },
  ): Promise<unknown>;
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
      concepts?: ReadonlyArray<{ title: string; type: (typeof BRAIN_NOTE_TYPES)[number] }>;
    },
  ): Promise<{
    path: string;
    title: string;
    created: boolean;
    links: readonly string[];
    newPages: readonly string[];
  }>;
  /** B3: unisce più note in una pagina (una sezione per nota); le originali restano nella cronologia. */
  merge(
    userId: string,
    input: { into: string; notes: readonly string[]; type?: (typeof BRAIN_NOTE_TYPES)[number] },
  ): Promise<{ path: string; title: string; merged: string[]; skipped: string[] }>;
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
        "Cerca nel second brain dell'utente (le sue note, documenti, pagine su persone, luoghi, progetti, ricette e immagini salvate). Filtri facoltativi: periodo a cui si riferiscono (from/to), luogo per nome o vicino alla posizione attuale (nearMe), tipo, note collegate a una pagina (linkedTo). Le note riservate restano escluse salvo includePrivate, da usare SOLO se l'utente lo chiede esplicitamente.",
      risk: { readsPrivate: true, ingestsUntrusted: true, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({
        query: z
          .string()
          .max(300)
          .optional()
          .describe('Parole o domanda; vuoto per elencare con i soli filtri'),
        type: z.enum([...BRAIN_NOTE_TYPES, 'ricetta', 'immagine']).optional(),
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
            path: z.string(),
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
            path: h.path,
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
        'Legge una scheda del Second Brain per percorso canonico da brain_search (preferito per evitare omonimi) o titolo. knowledge contiene fatti con stato, fonte, validità e revisioni precedenti, oltre agli orari abituali. Stato assente/unverified = da verificare, uncertain = dubbio, superseded = superato. confirmed vale solo rispetto alla fonte citata: non è una verifica indipendente. factAssessment calcola lo stato alla data locale odierna (non alla data di una domanda storica). Per domande sul presente usa solo la revisione corrente compatibile con la data richiesta; non usare history o dati scaduti come attuali. Non dedurre il domicilio di una persona dal luogo dei suoi parenti. Per una data precisa consulta brain_agenda.',
      risk: { readsPrivate: true, ingestsUntrusted: true, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({
        title: z.string().min(1).max(300).describe('Percorso path da brain_search, oppure titolo'),
        includeHistory: z
          .boolean()
          .optional()
          .describe(
            'Solo per domande sulle revisioni passate; omesso conserva un contesto compatto.',
          ),
      }),
      outputSchema: z.object({
        found: z.boolean(),
        title: z.string().optional(),
        path: z.string().optional(),
        type: z.string().optional(),
        date: z.string().optional(),
        place: z.string().nullable().optional(),
        links: z.array(z.string()).optional(),
        backlinks: z.array(z.string()).optional(),
        private: z.boolean().optional(),
        text: z.string().optional(),
        knowledge: BrainKnowledgeSchema.nullable().optional(),
        factAssessment: z
          .object({
            date: BrainDate,
            facts: z.array(
              z.object({
                id: z.string(),
                status: z.string(),
                validity: z.enum(['current', 'future', 'expired', 'unspecified']),
              }),
            ),
          })
          .optional(),
      }),
      execute: async ({ title, includeHistory }, ctx) => {
        const n = await store.read(ctx.userId, title);
        if (!n) return { found: false };
        const knowledge = n.knowledge ? BrainKnowledgeSchema.parse(n.knowledge) : null;
        if (knowledge && !includeHistory)
          knowledge.facts = knowledge.facts.map(({ history: _history, ...fact }) => fact);
        const zone = BrainTimeZone.safeParse(ctx.device?.timezone);
        const date = brainLocalDay(zone.success ? zone.data : 'Europe/Rome');
        return {
          found: true,
          title: n.title,
          path: n.path,
          type: n.type,
          date: n.refersFrom ?? n.created.slice(0, 10),
          place: n.place,
          links: [...n.links],
          backlinks: [...n.backlinks],
          private: n.private,
          text: n.body.length > 8000 ? `${n.body.slice(0, 8000)}…` : n.body,
          knowledge,
          ...(knowledge
            ? {
                factAssessment: {
                  date,
                  facts: knowledge.facts.map((fact) => ({
                    id: fact.id,
                    status: fact.status ?? 'unverified',
                    validity:
                      fact.validFrom && fact.validFrom > date
                        ? ('future' as const)
                        : fact.validUntil && fact.validUntil < date
                          ? ('expired' as const)
                          : fact.validFrom || fact.validUntil
                            ? ('current' as const)
                            : ('unspecified' as const),
                  })),
                },
              }
            : {}),
        };
      },
    }),
    defineTool({
      id: 'brain_knowledge_update',
      version: '1',
      category: 'brain',
      description:
        'Aggiorna fatti attuali e orari abituali nella scheda esistente indicata da ref (path da brain_search/brain_read). Non crea promemoria o notifiche. Prima leggi la scheda; conserva gli ID e modifica solo i dati forniti. Nuova routine: title, days ISO lun=1/dom=7, timeZone IANA e almeno un orario; separa inizio/fine attività, accompagnamento, ritiro e rientro previsto senza dedurre dati mancanti. Eccezioni per data: cancelled annulla solo quel giorno, changed cambia solo i campi indicati. Aggiornare una routine con id preserva gli altri campi. Usa routine distinte se giorni hanno orari diversi. Per i fatti conserva fonte evidence (kind, ref, quote), stato e validFrom/validUntil quando noti. Non assegnare confirmed per fiducia del modello: è ammesso solo con evidence.kind=user e citazione letterale nel messaggio corrente, verificata dal tool. Usa uncertain per deduzioni, unverified se manca la fonte; superseded per informazioni superate. Non dedurre domicilio dai parenti né rientro dalla fine dello sport. Se modifichi label/value, reinvia fonte e stato espliciti: quelli vecchi sono conservati nello storico, non ereditati. Non inventare citazioni o date. Chiedi una precisazione se serve.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 60_000,
      oncePerTurn: true,
      inputSchema: BrainKnowledgeUpdateSchema,
      outputSchema: z.object({
        path: z.string(),
        title: z.string(),
        knowledge: BrainKnowledgeSchema,
        notificationsCreated: z.literal(false),
      }),
      execute: async (input, ctx) => {
        if (!store.updateKnowledge)
          throw new ToolError('Schede strutturate non disponibili.', 'unavailable');
        try {
          const facts = input.facts?.map((fact) => {
            if (fact.status !== 'confirmed') return fact;
            const quote = fact.evidence?.quote.trim();
            if (fact.evidence?.kind !== 'user' || !quote || !ctx.userMessage?.includes(quote))
              throw new ToolError(
                'Per confermare serve una citazione letterale del messaggio corrente. Conserva il dato come da verificare o da chiarire.',
                'invalid_knowledge',
              );
            return {
              ...fact,
              evidence: {
                kind: 'user' as const,
                ref: `chat:${ctx.sessionId ?? 'current'}:${ctx.requestId}`,
                quote,
              },
            };
          });
          const result = await store.updateKnowledge(
            ctx.userId,
            facts ? { ...input, facts } : input,
          );
          return {
            path: result.path,
            title: result.title,
            knowledge: BrainKnowledgeSchema.parse(result.knowledge),
            notificationsCreated: false as const,
          };
        } catch (error) {
          throw brainToolError(error);
        }
      },
    }),
    defineTool({
      id: 'brain_agenda',
      version: '1',
      category: 'brain',
      description:
        'Consulta gli orari abituali salvati nel Second Brain in una data, applicando validità ed eccezioni. Per oggi/ domani usa date today/tomorrow: il giorno è calcolato nel fuso del telefono. ref facoltativo è il percorso della scheda persona/argomento; senza ref considera tutte le schede visibili. Risultati planned/cancelled descrivono programmi, non posizione reale o disponibilità garantita. Nessuna attività trovata non significa persona a casa. Non crea notifiche. Se non ci sono routine ma esistono vecchi appunti, cerca e leggi le fonti prima di rispondere.',
      risk: { readsPrivate: true, ingestsUntrusted: true, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z
        .object({
          date: z.union([BrainDate, z.enum(['today', 'tomorrow'])]).optional(),
          timeZone: BrainTimeZone.optional(),
          ref: z.string().trim().min(1).max(300).optional(),
          includePrivate: z
            .boolean()
            .optional()
            .describe('Solo se la persona chiede esplicitamente le note riservate.'),
        })
        .strict(),
      outputSchema: BrainAgendaSchema,
      execute: async (input, ctx) => {
        if (!store.agenda) throw new ToolError('Orari abituali non disponibili.', 'unavailable');
        const zone = BrainTimeZone.safeParse(input.timeZone ?? ctx.device?.timezone ?? 'UTC');
        if (!zone.success) throw new ToolError('Indica un fuso orario valido.', 'invalid_timezone');
        const date =
          !input.date || input.date === 'today' || input.date === 'tomorrow'
            ? brainLocalDay(zone.data, input.date === 'tomorrow' ? 1 : 0)
            : input.date;
        try {
          return BrainAgendaSchema.parse(
            await store.agenda(ctx.userId, {
              date,
              timeZone: zone.data,
              ...(input.ref ? { ref: input.ref } : {}),
              ...(input.includePrivate === true ? { includePrivate: true } : {}),
            }),
          );
        } catch (error) {
          throw brainToolError(error);
        }
      },
    }),
    defineTool({
      id: 'brain_write',
      version: '1',
      category: 'brain',
      description:
        "Scrive nel second brain dell'utente: crea una nota o una pagina (persona, luogo, progetto, argomento), aggiunge in fondo a una esistente (mode append) o la riscrive (mode replace). Collega persone, luoghi, progetti e argomenti scrivendo [[Titolo]] nel testo o in links. Se la nota nasce dove si trova l'utente, lascia hereAndNow attivo: luogo e coordinate vengono dal telefono. Ricette e immagini salvate hanno già una scheda gestita: per modificarle usa Ricette o Media, non brain_write. Ogni modifica resta nella cronologia ed è annullabile.",
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
        concepts: z
          .array(z.object({ title: z.string().max(120), type: z.enum(BRAIN_NOTE_TYPES) }))
          .max(12)
          .optional()
          .describe(
            'Tipo delle pagine collegate, per creare quelle che mancano (es. Emma → persona, Verona → luogo, Caldaia → argomento)',
          ),
      }),
      outputSchema: z.object({
        title: z.string(),
        created: z.boolean(),
        links: z.array(z.string()),
        newPages: z.array(z.string()),
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
          ...(input.concepts ? { concepts: input.concepts } : {}),
          source: input.spoken ? 'voce' : 'chat',
        });
        return {
          title: r.title,
          created: r.created,
          links: [...r.links],
          newPages: [...r.newPages],
        };
      },
    }),
    defineTool({
      id: 'brain_merge',
      version: '1',
      category: 'brain',
      description:
        "Riordina il second brain: unisce più note in una pagina (into), una sezione per nota con la sua data; le note originali spariscono (restano nella cronologia git) e le note che le citavano ora citano la pagina. Usalo SOLO dopo che l'utente ha detto di sì alla proposta.",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 60_000,
      inputSchema: z.object({
        into: z.string().min(2).max(120).describe('Pagina di destinazione (esistente o nuova)'),
        notes: z
          .array(z.string().min(1).max(160))
          .min(1)
          .max(30)
          .describe('Titoli delle note da unire'),
        type: z
          .enum(BRAIN_NOTE_TYPES)
          .optional()
          .describe('Tipo della pagina se nuova (predefinito argomento)'),
      }),
      outputSchema: z.object({
        title: z.string(),
        merged: z.array(z.string()),
        skipped: z.array(z.string()),
      }),
      execute: async (input, ctx) => {
        const r = await store.merge(ctx.userId, {
          into: input.into,
          notes: input.notes,
          ...(input.type ? { type: input.type } : {}),
        });
        return { title: r.title, merged: r.merged, skipped: r.skipped };
      },
    }),
  ];
}

function brainToolError(error: unknown): unknown {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    if (
      [
        'invalid_knowledge',
        'ambiguous_reference',
        'ambiguous_knowledge',
        'knowledge_render_conflict',
        'knowledge_merge_conflict',
        'note_not_found',
        'managed_note',
        'invalid_date',
        'invalid_timezone',
      ].includes(error.code)
    )
      return new ToolError(error.message, error.code);
  }
  return error;
}
