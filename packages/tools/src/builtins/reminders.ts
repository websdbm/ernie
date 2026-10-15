import type { ContentBlock } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

/**
 * Promemoria per il modello (richiesta dell'utente, 15 ott 2026): le frasi standard le prende la skill
 * deterministica «Ricordami» senza modello; quando la richiesta arriva in forma libera («ho il dentista alle 7 di
 * sera, mi avverti un'oretta prima?») il modello non deve spiegare come andrebbe detta, ma creare lui il
 * promemoria con questi tool. L'archivio vero è quello delle automazioni; qui c'è solo l'interfaccia.
 */
export interface ReminderToolInfo {
  readonly id: string;
  readonly text: string;
  readonly at: Date;
  /** Appuntamento con preavviso: ora dell'appuntamento (`at` è l'avviso). */
  readonly eventAt?: Date;
  readonly for?: string;
  readonly from?: string;
  readonly channels?: { readonly email?: boolean; readonly alarm?: boolean };
}

export interface ReminderToolStore {
  create(
    userId: string,
    input: {
      text: string;
      at: Date;
      timezone: string;
      eventAt?: Date;
      forLabel?: string;
      channels?: { email?: boolean; alarm?: boolean };
      literalTitle?: boolean;
    },
  ): Promise<ReminderToolInfo>;
  list(userId: string): Promise<ReminderToolInfo[]>;
  remove(userId: string, id: string): Promise<boolean>;
}

const Info = z.object({
  id: z.string(),
  text: z.string(),
  at: z.string(),
  eventAt: z.string().optional(),
  for: z.string().optional(),
  from: z.string().optional(),
});
type InfoOut = z.infer<typeof Info>;

const toInfo = (r: ReminderToolInfo): InfoOut => ({
  id: r.id,
  text: r.text,
  at: r.at.toISOString(),
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
      at: r.at.toISOString(),
      status: 'scheduled' as const,
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
      version: '1',
      category: 'reminders',
      description:
        "Crea un promemoria che suona sul telefono dell'utente a un'ora precisa. Usalo quando la persona chiede di essere avvisata o di ricordarsi qualcosa e la skill Ricordami non l'ha già fatto; non spiegare come dovrebbe formulare la frase. `at` è l'istante dell'avviso in formato ISO 8601 con fuso (es. 2026-10-15T18:00:00+02:00), calcolato dall'ora locale dell'utente. Appuntamento con preavviso («ho il dentista alle 19, avvisami alle 18» o «un'ora prima»): metti in `eventAt` l'ora dell'appuntamento e in `at` quella dell'avviso. Sveglia: `alarm` true. Se manca il giorno o l'ora e non si ricavano dal contesto, chiedi prima (una domanda chiusa con present_choices se le alternative sono poche).",
      risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
      timeoutMs: 8_000,
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(200)
          .describe('Cosa ricordare, breve e senza l’ora (es. «Dentista», «Chiamare Luca»)'),
        at: z.iso.datetime({ offset: true }).describe('Istante dell’avviso, ISO 8601 con fuso'),
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
        const timezone = zoneOf(ctx.device?.timezone, fallbackTz);
        try {
          const r = await store.create(ctx.userId, {
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
        return r ? block([r], out.eventAt ? 'Appuntamento' : 'Promemoria') : null;
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
  ];
}
