import {
  type ContentBlock,
  type ReminderDetails,
  type ReminderDetailsPatch,
  ReminderDetailsPatch as ReminderDetailsPatchSchema,
  ReminderDetails as ReminderDetailsSchema,
  type ReminderRepeat,
  ReminderRepeatInput,
  reminderDetailsOf,
  repeatLabel,
} from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

/**
 * Promemoria per il modello (richiesta dell'utente, 15 ott 2026): le frasi standard le prende la skill
 * deterministica «Ricordami» senza modello; quando la richiesta arriva in forma libera («ho il dentista alle 7 di
 * sera, mi avverti un'oretta prima?») il modello non deve spiegare come andrebbe detta, ma creare lui il
 * promemoria con questi tool. L'archivio vero è quello delle automazioni; qui c'è solo l'interfaccia.
 */
export interface ReminderToolPlace {
  readonly label: string;
  readonly on: 'arrive' | 'leave';
  readonly repeat?: boolean;
  readonly placeId?: string;
  readonly address?: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly radius?: number;
}

export interface ReminderToolInfo extends ReminderDetails {
  readonly locationAddress?: string;
  readonly id: string;
  readonly text: string;
  /** Assente nei promemoria legati a un luogo. */
  readonly at?: Date;
  readonly place?: ReminderToolPlace;
  /** Appuntamento con preavviso: ora dell'appuntamento (`at` è l'avviso). */
  readonly eventAt?: Date;
  readonly repeat?: ReminderRepeat;
  readonly for?: string;
  readonly from?: string;
  readonly channels?: { readonly email?: boolean; readonly alarm?: boolean };
}

export interface ReminderToolStore {
  create(
    userId: string,
    input: ReminderDetails & {
      text: string;
      at?: Date;
      place?: { label: string; on: 'arrive' | 'leave'; repeat?: boolean };
      timezone: string;
      repeat?: ReminderRepeat;
      eventAt?: Date;
      forLabel?: string;
      channels?: { email?: boolean; alarm?: boolean };
      literalTitle?: boolean;
    },
  ): Promise<ReminderToolInfo>;
  list(userId: string): Promise<ReminderToolInfo[]>;
  update?(
    userId: string,
    id: string,
    patch: ReminderDetailsPatch & { text?: string; at?: Date },
  ): Promise<ReminderToolInfo | null>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Salva l'indirizzo di un luogo nella scheda anagrafica («casa», «lavoro»). */
  setPlace?(
    userId: string,
    input: { label: string; address: string },
  ): Promise<{ label: string; address: string } | null>;
  /** Posizione attuale del telefono con un nome («salva questo posto come palestra»). */
  setPlaceHere?(
    userId: string,
    input: { label: string; lat: number; lng: number; accuracyM?: number },
  ): Promise<{ label: string; moved: boolean } | null>;
  renamePlace?(
    userId: string,
    from: string,
    to: string,
  ): Promise<
    | { ok: true; from: string; to: string; reminders: number }
    | { ok: false; reason: 'missing' | 'taken' | 'invalid' }
  >;
}

const Info = z.object({
  id: z.string(),
  text: z.string(),
  ...ReminderDetailsSchema.shape,
  locationAddress: z.string().optional(),
  at: z.string().optional(),
  place: z
    .object({
      label: z.string(),
      on: z.enum(['arrive', 'leave']),
      repeat: z.boolean().optional(),
      address: z.string().optional(),
    })
    .optional(),
  eventAt: z.string().optional(),
  repeat: ReminderRepeatInput.safeExtend({ label: z.string() }).optional(),
  for: z.string().optional(),
  from: z.string().optional(),
});
type InfoOut = z.infer<typeof Info>;

const toInfo = (r: ReminderToolInfo): InfoOut => ({
  id: r.id,
  text: r.text,
  ...reminderDetailsOf(r),
  ...(r.locationAddress ? { locationAddress: r.locationAddress } : {}),
  ...(r.at ? { at: r.at.toISOString() } : {}),
  ...(r.place
    ? {
        place: {
          label: r.place.label,
          on: r.place.on,
          ...(r.place.repeat ? { repeat: true } : {}),
          ...(r.place.address ? { address: r.place.address } : {}),
        },
      }
    : {}),
  ...(r.repeat
    ? {
        repeat: {
          ...r.repeat,
          weekdays: r.repeat.weekdays ? [...r.repeat.weekdays] : undefined,
          label: repeatLabel(r.repeat),
        },
      }
    : {}),
  ...(r.eventAt ? { eventAt: r.eventAt.toISOString() } : {}),
  ...(r.for ? { for: r.for } : {}),
  ...(r.from ? { from: r.from } : {}),
});

function block(items: readonly ReminderToolInfo[], title: string): ContentBlock {
  return {
    kind: 'reminders',
    title,
    reminders: items.slice(0, 50).map((r) => ({
      id: r.id,
      text: r.text.slice(0, 300),
      ...reminderDetailsOf(r),
      ...(r.locationAddress ? { locationAddress: r.locationAddress } : {}),
      ...(r.at ? { at: r.at.toISOString() } : {}),
      status: 'scheduled' as const,
      ...(r.place
        ? {
            place: {
              label: r.place.label.slice(0, 40),
              on: r.place.on,
              ...(r.place.repeat ? { repeat: true } : {}),
              ...(r.place.placeId ? { placeId: r.place.placeId } : {}),
              ...(r.place.address ? { address: r.place.address.slice(0, 160) } : {}),
              ...(r.place.lat !== undefined && r.place.lng !== undefined
                ? { lat: r.place.lat, lng: r.place.lng }
                : {}),
              ...(r.place.radius ? { radius: r.place.radius } : {}),
            },
          }
        : {}),
      ...(r.repeat
        ? {
            repeat: {
              ...r.repeat,
              weekdays: r.repeat.weekdays ? [...r.repeat.weekdays] : undefined,
              label: repeatLabel(r.repeat),
            },
          }
        : {}),
      ...(r.eventAt ? { eventAt: r.eventAt.toISOString() } : {}),
      ...(r.for ? { for: r.for.slice(0, 60) } : {}),
      ...(r.from ? { from: r.from.slice(0, 60) } : {}),
      ...(r.channels && (r.channels.email !== undefined || r.channels.alarm !== undefined)
        ? { channels: { ...r.channels } }
        : {}),
    })),
  };
}

/** Fuso del telefono se valido, altrimenti quello predefinito. */
function zoneOf(tz: string | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('it-IT', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return fallback;
  }
}

/** Il risultato dei tool tiene una copia dell'ultimo promemoria creato: serve alla scheda mostrata all'utente. */
const lastCreated = new Map<string, ReminderToolInfo>();
const lastListed = new Map<string, ReminderToolInfo[]>();

export function createReminderTools(
  store: ReminderToolStore,
  opts: { readonly defaultTimezone?: string } = {},
): ToolSpec[] {
  const fallbackTz = opts.defaultTimezone ?? 'Europe/Rome';
  return [
    defineTool({
      id: 'reminder_create',
      version: '3',
      category: 'reminders',
      description:
        "Crea un promemoria che suona sul telefono dell'utente a un'ora precisa (`at`) oppure quando arriva in un luogo o lo lascia (`place`, es. «quando arrivo a casa»: label «casa», on «arrive»; «ogni volta che» = repeat true). I luoghi sono quelli della scheda (casa, lavoro…): se l'utente ha appena detto l'indirizzo, salvalo prima con place_set. Usalo quando la persona chiede di essere avvisata o di ricordarsi qualcosa e la skill Ricordami non l'ha già fatto; non spiegare come dovrebbe formulare la frase. `at` è l'istante dell'avviso in formato ISO 8601 con fuso (es. 2026-10-15T18:00:00+02:00), calcolato dall'ora locale dell'utente. Appuntamento con preavviso («ho il dentista alle 19, avvisami alle 18» o «un'ora prima»): metti in `eventAt` l'ora dell'appuntamento e in `at` quella dell'avviso. Sveglia: `alarm` true. Per ricorrenze giornaliere, settimanali o mensili usa `repeat`: ora/minuto locali, weekdays 0=domenica…6=sabato; ogni mattina tranne weekend = weekly, weekdays [1,2,3,4,5]. Non creare tanti avvisi singoli e non dire che la ripetizione non esiste. La prossima occorrenza viene calcolata dal server: ometti `at`, `eventAt` e `place` quando usi `repeat`. Nessuna data iniziale/finale o esclusione di festività è supportata da repeat: se richiesta, chiarisci questo limite prima di salvare. Conserva sempre i dettagli forniti: location = indirizzo o etichetta del luogo dell’appuntamento (NON è il trigger place); url = link meeting/workshop completo, anche con parametri; notes = istruzioni e dettagli aggiuntivi. Non accorciare il link nel titolo. Questi campi sono facoltativi e si possono aggiungere dopo con reminder_update: non inventarli e chiedi solo se ambiguo. Se manca il giorno o l'ora e non si ricavano dal contesto, chiedi prima (una domanda chiusa con present_choices se le alternative sono poche).",
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 8_000,
      inputSchema: z.object({
        ...ReminderDetailsSchema.shape,
        text: z
          .string()
          .min(1)
          .max(200)
          .describe('Cosa ricordare, breve e senza l’ora (es. «Dentista», «Chiamare Luca»)'),
        at: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            'Istante dell’avviso, ISO 8601 con fuso (assente se il promemoria è legato a un luogo)',
          ),
        repeat: ReminderRepeatInput.optional().describe(
          'Ricorrenza locale. daily: ogni giorno; weekly: weekdays 0–6; monthly: day 1–28. Escluso weekend = weekdays [1,2,3,4,5]. Senza at/eventAt/place.',
        ),
        place: z
          .object({
            label: z
              .string()
              .min(1)
              .max(40)
              .describe('Luogo della scheda: «casa», «lavoro», «palestra»…'),
            on: z.enum(['arrive', 'leave']).describe('arrive = quando arriva, leave = quando esce'),
            repeat: z.boolean().optional().describe('true = ogni volta, non solo la prossima'),
          })
          .optional()
          .describe('Promemoria legato a un luogo, al posto di `at`'),
        eventAt: z.iso
          .datetime({ offset: true })
          .optional()
          .describe('Solo per gli appuntamenti con preavviso: ora dell’appuntamento (dopo `at`)'),
        alarm: z.boolean().optional().describe('true = suona come sveglia, senza email'),
        email: z.boolean().optional().describe('true = anche per email'),
        forLabel: z
          .string()
          .max(60)
          .optional()
          .describe(
            'Promemoria a una persona collegata (Famiglia), con la sua etichetta, es. «Giorgio»',
          ),
      }),
      outputSchema: Info,
      execute: async (input, ctx) => {
        const timezone = zoneOf(ctx.device?.timezone, fallbackTz);
        if (input.repeat) {
          if (input.at || input.eventAt || input.place)
            throw new ToolError(
              'La ricorrenza usa repeat senza at, eventAt o place. La prossima data viene calcolata dal server.',
              'invalid_input',
            );
          try {
            const r = await store.create(ctx.userId, {
              ...reminderDetailsOf(input),
              text: input.text,
              timezone,
              repeat: {
                kind: input.repeat.kind,
                hour: input.repeat.hour,
                minute: input.repeat.minute,
                ...(input.repeat.weekdays ? { weekdays: input.repeat.weekdays } : {}),
                ...(input.repeat.day !== undefined ? { day: input.repeat.day } : {}),
              },
              ...(input.forLabel ? { forLabel: input.forLabel } : {}),
              ...(input.alarm
                ? { channels: { alarm: true, email: false }, literalTitle: true }
                : input.email
                  ? { channels: { email: true } }
                  : {}),
            });
            lastCreated.set(ctx.userId, r);
            return toInfo(r);
          } catch (err) {
            if (err instanceof Error && err.name === 'UnknownPersonError')
              throw new ToolError(
                `Nessuna persona collegata si chiama «${input.forLabel}»: chiedi all’utente di collegarla da Impostazioni › Famiglia.`,
                'invalid_input',
              );
            throw err;
          }
        }
        if (input.place) {
          if (input.forLabel)
            throw new ToolError(
              'I promemoria legati a un luogo valgono solo per l’utente, non per i familiari: proponi un’ora precisa.',
              'invalid_input',
            );
          const label = input.place.label.trim().toLowerCase();
          const r = await store.create(ctx.userId, {
            ...reminderDetailsOf(input),
            text: input.text,
            timezone,
            place: { label, on: input.place.on, ...(input.place.repeat ? { repeat: true } : {}) },
          });
          lastCreated.set(ctx.userId, r);
          return toInfo(r);
        }
        if (!input.at)
          throw new ToolError('Serve `at` (un’ora) oppure `place` (un luogo).', 'invalid_input');
        const at = new Date(input.at);
        if (at.getTime() <= Date.now() + 30_000)
          throw new ToolError(
            'L’ora dell’avviso è già passata: chiedi un’altra ora.',
            'invalid_input',
          );
        const eventAt = input.eventAt ? new Date(input.eventAt) : undefined;
        if (eventAt && eventAt.getTime() <= at.getTime())
          throw new ToolError(
            'L’appuntamento (eventAt) deve venire dopo l’avviso (at).',
            'invalid_input',
          );
        try {
          const r = await store.create(ctx.userId, {
            ...reminderDetailsOf(input),
            text: input.text,
            at,
            timezone,
            ...(eventAt ? { eventAt } : {}),
            ...(input.forLabel ? { forLabel: input.forLabel } : {}),
            ...(input.alarm
              ? { channels: { alarm: true, email: false }, literalTitle: true }
              : input.email
                ? { channels: { email: true } }
                : {}),
          });
          lastCreated.set(ctx.userId, r);
          return toInfo(r);
        } catch (err) {
          if (err instanceof Error && err.name === 'UnknownPersonError')
            throw new ToolError(
              `Nessuna persona collegata si chiama «${input.forLabel}»: chiedi all’utente di collegarla da Impostazioni › Famiglia.`,
              'invalid_input',
            );
          throw err;
        }
      },
      present: (_input, out) => {
        const r = [...lastCreated.values()].find((x) => x.id === out.id);
        if (!r) return null;
        // Messo a un familiare: il titolo lo dice, così non sembra un promemoria mio.
        return block(
          [r],
          r.for ? `Promemoria per ${r.for}` : out.eventAt ? 'Appuntamento' : 'Promemoria',
        );
      },
    }),
    defineTool({
      id: 'reminder_list',
      version: '1',
      category: 'reminders',
      description:
        'Elenca i promemoria futuri dell’utente (e quelli che ha messo a persone collegate). Usalo per rispondere a «che promemoria ho?» o prima di annullarne uno.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 5_000,
      inputSchema: z.object({}),
      outputSchema: z.object({ reminders: z.array(Info) }),
      execute: async (_input, ctx) => {
        const list = await store.list(ctx.userId);
        lastListed.set(ctx.userId, list);
        return { reminders: list.map(toInfo) };
      },
      present: (_input, out) => {
        if (!out.reminders.length) return null;
        const ids = new Set(out.reminders.map((r) => r.id));
        const items = [...lastListed.values()].flat().filter((r) => ids.has(r.id));
        return items.length ? block(items, 'I tuoi promemoria') : null;
      },
    }),
    defineTool({
      id: 'reminder_cancel',
      version: '1',
      category: 'reminders',
      description:
        'Annulla un promemoria dato il suo id (preso da reminder_list). Conferma all’utente cosa hai annullato.',
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 5_000,
      inputSchema: z.object({ id: z.string().min(1).max(80) }),
      outputSchema: z.object({ removed: z.boolean() }),
      execute: async (input, ctx) => ({ removed: await store.remove(ctx.userId, input.id) }),
    }),
    defineTool({
      id: 'place_set',
      version: '2',
      category: 'reminders',
      description:
        'Dà un nome a un luogo e lo salva nella scheda dell’utente. Con un indirizzo: «casa mia è in via Roma 3, Treviso» → label «casa», address «via Roma 3, Treviso»; «lo studio di Giulia è in via Verdi 10» → label «studio di Giulia». Con la posizione attuale del telefono: «salva questo posto come palestra», «qui è la casa al mare» → label e here true. Serve ai promemoria legati a un luogo; il telefono trova da solo la posizione di un indirizzo. Dopo, conferma in una riga e ricorda che può controllare il punto in Impostazioni › La tua scheda › Luoghi.',
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 5_000,
      inputSchema: z.object({
        label: z
          .string()
          .min(1)
          .max(40)
          .describe(
            'Nome del luogo come lo dice l’utente: «casa», «palestra», «studio di Giulia»…',
          ),
        address: z
          .string()
          .min(5)
          .max(160)
          .optional()
          .describe('Indirizzo come lo dice l’utente: via, numero civico, città'),
        here: z
          .boolean()
          .optional()
          .describe('true = usa la posizione attuale del telefono («questo posto», «qui»)'),
      }),
      outputSchema: z.object({
        label: z.string(),
        address: z.string().optional(),
        here: z.boolean().optional(),
      }),
      execute: async (input, ctx) => {
        const label = input.label.trim().toLowerCase();
        if (input.here || !input.address) {
          const loc = ctx.device?.location;
          if (!input.here)
            throw new ToolError(
              'Serve un indirizzo oppure here true (posizione attuale).',
              'invalid_input',
            );
          if (!loc)
            throw new ToolError(
              'La posizione del telefono non è disponibile: chiedi all’utente l’indirizzo o di attivare la posizione per Ernie.',
              'unavailable',
            );
          if (!store.setPlaceHere)
            throw new ToolError('I luoghi non sono disponibili su questo server.', 'unavailable');
          const saved = await store.setPlaceHere(ctx.userId, {
            label,
            lat: loc.latitude,
            lng: loc.longitude,
          });
          if (!saved)
            throw new ToolError(
              'Non riesco a salvare il luogo (forse ce ne sono già dieci): chiedi all’utente di gestirli in Impostazioni › La tua scheda › Luoghi.',
              'invalid_input',
            );
          return { label: saved.label, here: true };
        }
        if (!store.setPlace)
          throw new ToolError('I luoghi non sono disponibili su questo server.', 'unavailable');
        const saved = await store.setPlace(ctx.userId, { label, address: input.address.trim() });
        if (!saved)
          throw new ToolError(
            'Non riesco a salvare il luogo (forse ce ne sono già dieci): chiedi all’utente di gestirli in Impostazioni › La tua scheda › Luoghi.',
            'invalid_input',
          );
        return saved;
      },
    }),
    defineTool({
      id: 'place_rename',
      version: '1',
      category: 'reminders',
      description:
        'Cambia il nome di un luogo della scheda («rinomina dentista in studio Rossi», «chiama la palestra “piscina”»): posizione e promemoria legati restano, con il nome nuovo.',
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 5_000,
      inputSchema: z.object({
        from: z.string().min(1).max(40).describe('Nome attuale del luogo'),
        to: z.string().min(1).max(40).describe('Nome nuovo'),
      }),
      outputSchema: z.object({ from: z.string(), to: z.string(), reminders: z.number() }),
      execute: async (input, ctx) => {
        if (!store.renamePlace)
          throw new ToolError('I luoghi non sono disponibili su questo server.', 'unavailable');
        const res = await store.renamePlace(ctx.userId, input.from.trim(), input.to.trim());
        if (!res.ok)
          throw new ToolError(
            res.reason === 'missing'
              ? `Nella scheda non c’è un luogo chiamato «${input.from}».`
              : res.reason === 'taken'
                ? `C’è già un luogo chiamato «${input.to}».`
                : 'Nome non valido.',
            'invalid_input',
          );
        return { from: res.from, to: res.to, reminders: res.reminders };
      },
    }),
    defineTool({
      id: 'reminder_update',
      version: '1',
      category: 'reminders',
      description:
        'Modifica un promemoria esistente senza duplicarlo. Prima usa reminder_list per identificarlo: se più impegni corrispondono chiedi quale con present_choices. Aggiunge, cambia o rimuove luogo (location: indirizzo o etichetta), URL meeting (url) e note (notes), anche in un secondo momento. Campi omessi invariati; null cancella. Può cambiare testo e ora dell’avviso (at ISO con fuso). Non trasformare una sede in un avviso geolocalizzato. Chiedi un dettaglio mirato solo se necessario; non inventare dati.',
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 8_000,
      inputSchema: z
        .object({
          id: z.uuid(),
          text: z.string().trim().min(1).max(300).optional(),
          at: z.iso.datetime({ offset: true }).optional(),
          ...ReminderDetailsPatchSchema.shape,
        })
        .refine(
          ({ id: _id, ...patch }) => Object.values(patch).some((v) => v !== undefined),
          'Indica almeno un campo da modificare',
        ),
      outputSchema: Info,
      execute: async (input, ctx) => {
        if (!store.update)
          throw new ToolError('La modifica dei promemoria non è disponibile.', 'unavailable');
        const at = input.at ? new Date(input.at) : undefined;
        if (at && at.getTime() <= Date.now() + 30_000)
          throw new ToolError(
            'L’ora dell’avviso è già passata: chiedi un’altra ora.',
            'invalid_input',
          );
        const r = await store.update(ctx.userId, input.id, {
          ...ReminderDetailsPatchSchema.parse(input),
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(at ? { at } : {}),
        });
        if (!r)
          throw new ToolError(
            'Promemoria non trovato o non modificabile: rileggi la lista.',
            'invalid_input',
          );
        lastCreated.set(ctx.userId, r);
        return toInfo(r);
      },
      present: (_input, out) => {
        const r = [...lastCreated.values()].find((x) => x.id === out.id);
        return r ? block([r], 'Promemoria aggiornato') : null;
      },
    }),
  ];
}
