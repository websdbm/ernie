import { z } from 'zod';

/** Server-owned continuation; scoped to account/session and consumed atomically once. */
export const ResolverChoice = z.object({
  message: z.string().min(1).max(32_000),
  question: z.string().min(1).max(200),
  kind: z.enum(['meaning', 'capability']),
  options: z
    .array(z.object({ label: z.string().max(80), value: z.string().max(100) }))
    .min(2)
    .max(4),
  createdAt: z.number(),
  habitTimezone: z.string().max(80).optional(),
});
export type ResolverChoice = z.infer<typeof ResolverChoice>;

export function resolveChoice(pending: ResolverChoice | null, text: string) {
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) return undefined;
  const normalized = text.trim().toLocaleLowerCase('it');
  const matches = pending.options.filter((o) => o.label.toLocaleLowerCase('it') === normalized);
  if (matches.length !== 1) return undefined;
  const selected = matches[0];
  if (!selected) return undefined;
  return {
    message: pending.message,
    note: `Richiesta originale dell’utente: «${pending.message}».\nAlla domanda «${pending.question}» l’utente ha scelto «${selected.label}». Riprendi questa richiesta con la scelta indicata; non riproporre la domanda già risolta. Chiedi solo i dati ancora mancanti, senza inventarli. La scelta della funzione non sostituisce le conferme previste per le azioni.`,
    ...(pending.kind === 'capability'
      ? { skillId: selected.value === 'none' ? null : selected.value }
      : {}),
  };
}

/** An explicit empty reminder command needs content/time, not another capability election. */
export function isExplicitReminderStart(text: string): boolean {
  return /^(?:(?:imposta|crea|aggiungi|metti|inserisci)(?:mi)?\s+(?:un\s+)?promemoria|ricordami)[.!]?$/iu.test(
    text.trim(),
  );
}
