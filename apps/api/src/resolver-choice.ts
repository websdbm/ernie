import { z } from 'zod';

/** Server-owned continuation; scoped to account/session and consumed atomically once. */
export const ResolverChoice = z
  .object({
    message: z.string().min(1).max(32_000),
    question: z.string().min(1).max(200),
    kind: z.enum(['meaning', 'capability', 'followup']),
    options: z.array(z.object({ label: z.string().max(80), value: z.string().max(100) })).max(4),
    createdAt: z.number(),
    habitTimezone: z.string().max(80).optional(),
  })
  .refine((v) => v.kind === 'followup' || v.options.length >= 2);
export type ResolverChoice = z.infer<typeof ResolverChoice>;

export function resolveChoice(
  pending: ResolverChoice | null,
  text: string,
):
  | {
      message: string;
      note: string;
      skillId?: string | null;
      followup?: boolean;
    }
  | undefined {
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) return undefined;
  const normalized = text.trim().toLocaleLowerCase('it');
  if (pending.kind === 'followup') {
    if (
      !isFollowupAnswer(
        text,
        pending.question,
        pending.options.map((o) => o.label),
      )
    )
      return undefined;
    return {
      message: text,
      followup: true,
      note: `L’utente risponde alla domanda rimasta aperta: «${pending.question}».\nLa risposta è «${text}».\nContesto della domanda, formulata il ${new Date(pending.createdAt).toISOString()}:\n${pending.message}\nAssocia la risposta alla domanda indicata. Gli altri impegni già creati o modificati nella conversazione sono conclusi. Riprendi solo il punto ancora aperto, controlla gli impegni esistenti prima di scrivere ed evita duplicati. Le conferme degli strumenti restano necessarie.`,
    };
  }
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

export function isFollowupAnswer(text: string, question: string, options: readonly string[] = []) {
  const t = text
    .trim()
    .toLocaleLowerCase('it')
    .replace(/[.!]+$/u, '')
    .trim();
  if (options.some((o) => o.toLocaleLowerCase('it') === t)) return true;
  if (
    /^(?:s[iì](?:,? (?:grazie|fallo|procedi|va bene))?|no(?:,? grazie)?|va bene|ok(?:ay)?(?:,? procedi)?|confermo|procedi|fallo)$/u.test(
      t,
    )
  )
    return true;
  return (
    /\b(?:quando|che ora|che orario|quale ora)\b/iu.test(question) &&
    /^(?:(?:oggi|domani|dopodomani|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica)(?:\s+(?:mattina|pomeriggio|sera))?\s+)?(?:alle\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?(?:\s+(?:di mattina|di sera|del mattino|del pomeriggio))?$/u.test(
      t,
    )
  );
}

export function lastAssistantQuestion(text: string): string | null {
  const match = Array.from(text.matchAll(/[^.!?\n]+\?/gu)).at(-1);
  if (!match || text.slice(match.index + match[0].length).replace(/[\s*_'"»”]+/gu, '')) return null;
  const last = match[0].trim();
  return last && last.length <= 200 ? last : null;
}

/** An explicit empty reminder command needs content/time, not another capability election. */
export function isExplicitReminderStart(text: string): boolean {
  return /^(?:(?:imposta|crea|aggiungi|metti|inserisci)(?:mi)?\s+(?:un\s+)?promemoria|ricordami)[.!]?$/iu.test(
    text.trim(),
  );
}
