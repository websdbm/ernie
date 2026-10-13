import { addDays, localParts, zonedToUtc } from './zoned.js';

/**
 * Promemoria ricorrenti (richiesta dell'utente, 13 ott 2026): «ricordami ogni venerdì alle 9 di andare in
 * palestra», «ogni lunedì e giovedì alle 18», «ogni giorno alle 8», «nei giorni feriali alle 7:30»,
 * «il 5 di ogni mese». Senza modello; diventano automazioni con orario ricorrente (cron).
 */
export interface ReminderRepeat {
  readonly kind: 'daily' | 'weekly' | 'monthly';
  /** 0 = domenica … 6 = sabato (solo weekly). */
  readonly weekdays?: readonly number[];
  /** Giorno del mese (solo monthly). */
  readonly day?: number;
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const WEEKDAY_FORMS: Record<string, number> = {
  domenica: 0,
  domeniche: 0,
  lunedì: 1,
  lunedi: 1,
  martedì: 2,
  martedi: 2,
  mercoledì: 3,
  mercoledi: 3,
  giovedì: 4,
  giovedi: 4,
  venerdì: 5,
  venerdi: 5,
  sabato: 6,
  sabati: 6,
};
const DAY_RE = Object.keys(WEEKDAY_FORMS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const SMALL: Record<string, number> = {
  primo: 1,
  uno: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  quindici: 15,
  venti: 20,
  trenta: 30,
};

const hhmm = (h: number, m: number) => (m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`);

/** «ogni venerdì alle 9», «ogni lunedì e giovedì alle 18:30», «ogni giorno alle 8», «il 5 di ogni mese alle 9». */
export function repeatLabel(r: ReminderRepeat): string {
  const at = `alle ${hhmm(r.hour, r.minute)}`;
  if (r.kind === 'daily') return `ogni giorno ${at}`;
  if (r.kind === 'monthly') return `il ${r.day} di ogni mese ${at}`;
  const days = [...(r.weekdays ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)))
    return `nei giorni feriali ${at}`;
  const names = days.map((d) => WEEKDAYS[d] ?? '');
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0];
  return `ogni ${list} ${at}`;
}

/** Espressione cron (minuto ora giorno mese giorno-della-settimana). */
export function repeatCron(r: ReminderRepeat): string {
  if (r.kind === 'daily') return `${r.minute} ${r.hour} * * *`;
  if (r.kind === 'monthly') return `${r.minute} ${r.hour} ${r.day} * *`;
  return `${r.minute} ${r.hour} * * ${[...(r.weekdays ?? [])].sort().join(',')}`;
}

/** Prima occorrenza da adesso (esclusa) nel fuso indicato. */
export function firstOccurrence(r: ReminderRepeat, now: Date, tz: string): Date {
  const t = localParts(now, tz);
  for (let i = 0; i < 400; i++) {
    const [y, m, d] = addDays(t.year, t.month, t.day, i);
    const at = zonedToUtc(tz, y, m, d, r.hour, r.minute);
    if (at.getTime() <= now.getTime()) continue;
    const weekday = localParts(at, tz).weekday;
    if (r.kind === 'daily') return at;
    if (r.kind === 'weekly' && r.weekdays?.includes(weekday)) return at;
    if (r.kind === 'monthly' && d === r.day) return at;
  }
  return zonedToUtc(tz, t.year + 1, t.month, t.day, r.hour, r.minute);
}

/** Orario del giorno: «alle 9», «alle 18:30», «alle 7 di sera», altrimenti il momento della giornata. */
function timeOfDay(text: string): { hour: number; minute: number; text: string; assumed?: string } {
  const tm =
    /\s(?:alle|all'|per\s+le|verso\s+le)\s*(?:ore\s+)?(?<h>\d{1,2})(?:[:.,](?<mi>\d{2}))?(?:\s+e\s+(?<frac>mezza|mezzo|un\s+quarto|tre\s+quarti))?(?:\s+(?<ap>di\s+mattina|del\s+mattino|di\s+pomeriggio|del\s+pomeriggio|di\s+sera|della\s+sera))?\s/iu.exec(
      text,
    );
  if (tm?.groups?.h) {
    let hour = Number(tm.groups.h);
    let minute = tm.groups.mi ? Number(tm.groups.mi) : 0;
    const frac = tm.groups.frac?.toLowerCase();
    if (frac?.startsWith('mezz')) minute = 30;
    else if (frac === 'un quarto') minute = 15;
    else if (frac === 'tre quarti') minute = 45;
    if (/sera|pomeriggio/.test(tm.groups.ap ?? '') && hour < 12) hour += 12;
    return { hour, minute, text: text.replace(tm[0], ' ') };
  }
  const periods: Array<[RegExp, number, string]> = [
    [/\s(?:la\s+|di\s+|al\s+)?mattin[ao]\s/iu, 9, 'mattina'],
    [/\s(?:il\s+|di\s+|nel\s+)?pomeriggio\s/iu, 15, 'pomeriggio'],
    [/\s(?:la\s+|di\s+|in\s+)?sera(?:ta)?\s/iu, 20, 'sera'],
    [/\s(?:a\s+)?mezzogiorno\s/iu, 12, ''],
  ];
  for (const [re, h, label] of periods) {
    const m = re.exec(text);
    if (m)
      return {
        hour: h,
        minute: 0,
        text: text.replace(m[0], ' '),
        ...(label ? { assumed: `le ${h} per «${label}»` } : {}),
      };
  }
  return { hour: 9, minute: 0, text, assumed: 'le 9, perché non hai detto l’ora' };
}

/**
 * Riconosce una ricorrenza nella parte della frase dopo «ricordami». Restituisce la ricorrenza, il testo
 * residuo (cosa ricordare) e le stime fatte; null se la frase non è ricorrente.
 */
export function parseRepeat(
  rest: string,
): { repeat: ReminderRepeat; text: string; assumed: string[] } | null {
  let text = ` ${rest.replace(/[‘’´`]/gu, "'")} `;
  let kind: ReminderRepeat['kind'] | null = null;
  let weekdays: number[] | undefined;
  let day: number | undefined;
  let periodWord: string | null = null;

  const feriali =
    /\s(?:(?:in|nei)\s+giorni\s+feriali|ogni\s+giorno\s+feriale|tutti\s+i\s+giorni\s+feriali|dal\s+lunedì\s+al\s+venerdì|dal\s+lunedi\s+al\s+venerdi)\s/iu.exec(
      text,
    );
  const weekly = new RegExp(
    `\\s(?:ogni|tutti\\s+i|tutte\\s+le)\\s+(?<days>(?:${DAY_RE})(?:\\s*(?:,|e)\\s*(?:${DAY_RE}))*)(?:\\s+(?<p>mattina|pomeriggio|sera))?\\s`,
    'iu',
  ).exec(text);
  const daily =
    /\s(?:ogni\s+giorno|tutti\s+i\s+giorni|ogni\s+(?<p>mattina|pomeriggio|sera)|tutte\s+le\s+(?<p2>mattine|sere))\s/iu.exec(
      text,
    );
  const monthly = new RegExp(
    `\\s(?:(?:il|ogni)\\s+(?<d1>\\d{1,2}|${Object.keys(SMALL).join('|')})\\s+(?:di\\s+)?ogni\\s+mese|ogni\\s+mese\\s+il\\s+(?<d2>\\d{1,2}|${Object.keys(SMALL).join('|')}))\\s`,
    'iu',
  ).exec(text);

  if (feriali) {
    kind = 'weekly';
    weekdays = [1, 2, 3, 4, 5];
    text = text.replace(feriali[0], ' ');
  } else if (weekly?.groups?.days) {
    kind = 'weekly';
    weekdays = [
      ...new Set(
        weekly.groups.days
          .split(/\s*(?:,|\se\s)\s*/iu)
          .map((w) => WEEKDAY_FORMS[w.trim().toLowerCase()])
          .filter((n): n is number => n !== undefined),
      ),
    ];
    periodWord = weekly.groups.p ?? null;
    text = text.replace(weekly[0], ' ');
  } else if (monthly) {
    const raw = (monthly.groups?.d1 ?? monthly.groups?.d2 ?? '').toLowerCase();
    day = /^\d+$/.test(raw) ? Number(raw) : SMALL[raw];
    if (!day || day < 1 || day > 28) return null; // oltre il 28 non tutti i mesi lo hanno
    kind = 'monthly';
    text = text.replace(monthly[0], ' ');
  } else if (daily) {
    kind = 'daily';
    const p = (daily.groups?.p ?? daily.groups?.p2 ?? '').toLowerCase();
    periodWord = p.startsWith('mattin') ? 'mattina' : p.startsWith('ser') ? 'sera' : p || null;
    text = text.replace(daily[0], ' ');
  }
  if (!kind) return null;
  if (kind === 'weekly' && !weekdays?.length) return null;

  const withPeriod = periodWord ? `${text} ${periodWord} ` : text;
  const t = timeOfDay(withPeriod);
  const assumed = t.assumed ? [t.assumed] : [];
  const cleaned = t.text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:di|che|a)\s+/iu, '')
    .replace(/\s+(?:di|a|e|che)$/iu, '')
    .trim();
  if (!cleaned) return null;
  return {
    repeat: {
      kind,
      hour: t.hour,
      minute: t.minute,
      ...(weekdays ? { weekdays } : {}),
      ...(day ? { day } : {}),
    },
    text: cleaned,
    assumed,
  };
}
