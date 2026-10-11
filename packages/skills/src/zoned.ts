/** Date e ore in un fuso orario IANA senza dipendenze: componenti locali ↔ istante UTC. */

export interface LocalParts {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number; // 0 = domenica … 6 = sabato
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Componenti locali di un istante nel fuso dato. */
export function localParts(date: Date, tz: string): LocalParts {
  const map: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: WEEKDAYS.indexOf(map.weekday ?? 'Sun'),
  };
}

/** Istante UTC per i componenti locali dati (gestisce l'ora legale con due passaggi). */
export function zonedToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (t: number) => {
    const p = localParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}

/** Aggiunge giorni a una data locale (anno, mese, giorno) restituendo i nuovi componenti. */
export function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}
