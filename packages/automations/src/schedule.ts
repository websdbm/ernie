import { CronExpressionParser } from 'cron-parser';
import type { Trigger } from './schema.js';

/** Fascia notturna da evitare (ora locale dell'automazione): 01:00–03:59, finestra di manutenzione e backup. */
export const QUIET_HOURS: readonly number[] = [1, 2, 3];

export class TriggerValidationError extends Error {
  override readonly name = 'TriggerValidationError';
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('it-IT', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localHour(date: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date)
    .find((p) => p.type === 'hour')?.value;
  return Number(h ?? -1);
}

/** Prossime `n` occorrenze di un pattern cron nel fuso indicato, a partire da `from` (esclusa). */
export function nextOccurrences(pattern: string, tz: string, from: Date, n: number): Date[] {
  const expr = CronExpressionParser.parse(pattern, { currentDate: from, tz });
  const out: Date[] = [];
  for (let i = 0; i < n && expr.hasNext(); i++) out.push(expr.next().toDate());
  return out;
}

/**
 * Istante pianificato di un tick cron: l'ultima occorrenza ≤ `now` (secondo di tolleranza).
 * Due scheduler che ricevono lo stesso tick, anche con ritardi diversi, calcolano lo stesso valore.
 */
export function previousOccurrence(pattern: string, tz: string, now: Date): Date {
  const expr = CronExpressionParser.parse(pattern, {
    currentDate: new Date(now.getTime() + 1_000),
    tz,
  });
  return expr.prev().toDate();
}

/** Valida trigger e fuso: pattern cron analizzabile, intervallo minimo 5 minuti, nessuna occorrenza nella fascia notturna. */
export function validateTrigger(trigger: Trigger, tz: string, now = new Date()): void {
  if (!isValidTimezone(tz)) throw new TriggerValidationError(`fuso orario non valido: ${tz}`);
  if (trigger.type === 'cron') {
    let next: Date[];
    try {
      next = nextOccurrences(trigger.pattern, tz, now, 20);
    } catch (err) {
      throw new TriggerValidationError(
        `pattern cron non valido: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (next.length === 0)
      throw new TriggerValidationError('il pattern cron non ha occorrenze future');
    for (let i = 1; i < next.length; i++) {
      const a = next[i - 1];
      const b = next[i];
      if (a && b && b.getTime() - a.getTime() < 5 * 60_000)
        throw new TriggerValidationError('intervallo minimo tra due esecuzioni: 5 minuti');
    }
    const quiet = next.find((d) => QUIET_HOURS.includes(localHour(d, tz)));
    if (quiet)
      throw new TriggerValidationError(
        `il pattern cade nella fascia notturna 01:00–03:59 (${tz}), riservata alla manutenzione`,
      );
  } else if (trigger.type === 'once') {
    const at = new Date(trigger.at);
    if (at.getTime() <= now.getTime())
      throw new TriggerValidationError("l'istante dell'esecuzione una tantum è già passato");
    if (QUIET_HOURS.includes(localHour(at, tz)))
      throw new TriggerValidationError(`l'istante cade nella fascia notturna 01:00–03:59 (${tz})`);
  }
}

/** Ritardo casuale in millisecondi entro il jitter configurato (distribuisce il carico sugli orari pieni). */
export function jitterMs(jitterSeconds: number, random = Math.random): number {
  if (jitterSeconds <= 0) return 0;
  return Math.floor(random() * jitterSeconds * 1000);
}

/** Vero se una run cron parte troppo tardi rispetto all'istante pianificato (worker fermo, coda intasata). */
export function isTooLate(
  scheduledAt: Date,
  now: Date,
  jitterSeconds: number,
  toleranceSeconds: number,
): boolean {
  return now.getTime() - scheduledAt.getTime() > (toleranceSeconds + jitterSeconds) * 1000;
}

export const dedupeKeys = {
  cron: (scheduledAt: Date) => `cron:${scheduledAt.toISOString()}`,
  once: (at: Date) => `once:${at.toISOString()}`,
  webhook: (idempotencyKey: string) => `webhook:${idempotencyKey}`,
  event: (eventId: string) => `event:${eventId}`,
  manual: (id: string) => `manual:${id}`,
};
