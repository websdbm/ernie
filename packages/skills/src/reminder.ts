import type { ContentBlock } from '@ernie/protocol';
import type { DeterministicSkill, SkillReply } from './types.js';
import { addDays, localParts, zonedToUtc } from './zoned.js';

/**
 * Skill «Ricordami» (deterministica, nessun modello): «ricordami di uscire alle 17», «ricordami domani alle 9 di
 * chiamare il dentista», «tra 20 minuti», «stasera», «lunedì alle 8», «il 15 ottobre alle 10:30».
 * Giorno omesso = oggi (se l'ora è già passata, domani). Il promemoria è un'automazione una tantum: all'ora
 * stabilita il worker esegue questa skill con l'input `__promemoria__ <testo>` e la notifica parte da sola
 * (scheda nell'app, push se configurato, email se l'utente l'ha chiesta). «Che promemoria ho?» e
 * «annulla il promemoria …» per gestirli.
 */
export interface Reminder {
  readonly id: string;
  readonly text: string;
  readonly at: Date;
  readonly status: 'scheduled' | 'done' | 'cancelled';
  /** Promemoria messo da me a una persona collegata (Famiglia): la sua etichetta («Giorgio»). */
  readonly for?: string;
  /** Promemoria messo a me da una persona collegata: la sua etichetta («papà»). */
  readonly from?: string;
}

/** «Ricorda a Giorgio…» senza un collegamento con quell'etichetta. */
export class UnknownPersonError extends Error {
  constructor(readonly label: string) {
    super(`persona sconosciuta: ${label}`);
    this.name = 'UnknownPersonError';
  }
}

export interface ReminderStore {
  /** Con `forLabel` il promemoria va a una persona collegata (Famiglia); se non esiste: UnknownPersonError. */
  create(
    userId: string,
    input: { text: string; at: Date; timezone: string; forLabel?: string },
  ): Promise<Reminder>;
  /** Promemoria futuri ancora attivi, dal più vicino. */
  list(userId: string): Promise<Reminder[]>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Cambia testo e/o ora (dalla scheda nell'app): restituisce il promemoria aggiornato (può avere un id nuovo). */
  update(userId: string, id: string, patch: { text?: string; at?: Date }): Promise<Reminder | null>;
}

export type ReminderPlan =
  | { op: 'create'; text: string; at: Date; assumed: string[]; who?: string }
  | { op: 'ask_time'; text: string; who?: string }
  | { op: 'list' }
  | { op: 'cancel'; what: string }
  | { op: 'fire'; text: string; from?: string };

export const REMINDER_FIRE_PREFIX = '__promemoria__ ';

/** Giorni del mese in lettere («il due novembre», «il primo dicembre», «il ventitré»). */
const DAY_WORDS: Record<string, number> = Object.fromEntries(
  [
    ['primo', 1],
    ['uno', 1],
    ['due', 2],
    ['tre', 3],
    ['quattro', 4],
    ['cinque', 5],
    ['sei', 6],
    ['sette', 7],
    ['otto', 8],
    ['nove', 9],
    ['dieci', 10],
    ['undici', 11],
    ['dodici', 12],
    ['tredici', 13],
    ['quattordici', 14],
    ['quindici', 15],
    ['sedici', 16],
    ['diciassette', 17],
    ['diciotto', 18],
    ['diciannove', 19],
    ['venti', 20],
    ['ventuno', 21],
    ['ventidue', 22],
    ['ventitré', 23],
    ['ventitre', 23],
    ['ventiquattro', 24],
    ['venticinque', 25],
    ['ventisei', 26],
    ['ventisette', 27],
    ['ventotto', 28],
    ['ventinove', 29],
    ['trenta', 30],
    ['trentuno', 31],
  ].map(([w, n]) => [w, n]),
) as Record<string, number>;
// Dalla parola più lunga: «ventitré» non deve diventare «venti» + «tré».
const DAY_WORDS_RE = Object.keys(DAY_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];
const NUM_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  "un'": 1,
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
  quarantacinque: 45,
  sessanta: 60,
};

interface Parsed {
  readonly text: string;
  readonly at: Date;
  readonly assumed: string[];
}

/** «Prendere Giorgio» → «prendere Giorgio» dentro una frase (i nomi propri restano maiuscoli). */
export const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * Titolo deterministico del promemoria (ripiego quando il modello leggero non c'è): via i giri di parole
 * più comuni del parlato («uscire per andare a prendere…» → «Prendere…»), maiuscola iniziale.
 */
export function tidyReminderText(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:devo\s+|dovrei\s+|bisogna\s+|ricordarmi\s+di\s+)/iu, '');
  // «uscire per andare a prendere», «uscire per prendere», «andare a prendere»: resta il verbo che conta.
  t = t.replace(
    /^(?:uscire\s+(?:per\s+)?)?(?:(?:per\s+)?andare\s+a\s+)?(?=\p{L}+(?:are|ere|ire)\b)/iu,
    '',
  );
  t = t.replace(/^uscire\s+per\s+/iu, '');
  t = t.replace(/\ba\s+lavoro\b/iu, 'al lavoro');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(di|che|a)\s+/i, '')
    .replace(/\s+(di|a|e|che)$/i, '')
    .trim();

/** Estrae giorno e ora dalla frase; restituisce il testo residuo e l'istante. */
export function parseWhen(
  rest: string,
  now: Date,
  tz: string,
): Parsed | { needTime: string } | null {
  let text = ` ${rest.replace(/[‘’´`]/gu, "'")} `;
  const assumed: string[] = [];
  const today = localParts(now, tz);
  let [y, m, d] = [today.year, today.month, today.day];
  let dayGiven = false;
  let hour: number | null = null;
  let minute = 0;
  let timeGiven = false;

  // Relativo: «tra 20 minuti», «fra un'ora», «tra 2 giorni».
  const rel =
    /\s(?:tra|fra)\s+(?<n>\d+|un'|una|un|due|tre|quattro|cinque|sei|dieci|quindici|venti|trenta|quarantacinque|sessanta)\s*(?<u>minut[oi]|or[ae]|giorn[oi]|settiman[ae])\s/iu.exec(
      text,
    );
  if (rel?.groups) {
    const n = /^\d+$/.test(rel.groups.n ?? '')
      ? Number(rel.groups.n)
      : (NUM_WORDS[(rel.groups.n ?? '').toLowerCase()] ?? 1);
    const u = (rel.groups.u ?? '').toLowerCase();
    const ms = u.startsWith('min')
      ? n * 60_000
      : u.startsWith('or')
        ? n * 3_600_000
        : u.startsWith('giorn')
          ? n * 86_400_000
          : n * 7 * 86_400_000;
    const at = new Date(now.getTime() + ms);
    text = text.replace(rel[0], ' ');
    return { text: clean(text), at, assumed };
  }

  // Giorno.
  const dayWords: Array<[RegExp, (m: RegExpExecArray) => void]> = [
    [
      /\sdopodomani\s/iu,
      () => {
        [y, m, d] = addDays(y, m, d, 2);
        dayGiven = true;
      },
    ],
    [
      /\sdomani\s/iu,
      () => {
        [y, m, d] = addDays(y, m, d, 1);
        dayGiven = true;
      },
    ],
    [
      /\soggi\s/iu,
      () => {
        dayGiven = true;
      },
    ],
  ];
  for (const [re, apply] of dayWords) {
    const mm = re.exec(text);
    if (mm) {
      apply(mm);
      text = text.replace(mm[0], ' ');
    }
  }
  const wd = new RegExp(
    `\\s(?:(?:il|al|per|di)\\s+)?(?:prossim[oa]\\s+)?(?<w>${WEEKDAYS.join('|')})(?:\\s+prossim[oa])?\\s`,
    'iu',
  ).exec(text);
  if (wd?.groups?.w) {
    const target = WEEKDAYS.indexOf(wd.groups.w.toLowerCase());
    let delta = (target - today.weekday + 7) % 7;
    if (delta === 0) delta = 7; // «lunedì» di lunedì = lunedì prossimo
    [y, m, d] = addDays(today.year, today.month, today.day, delta);
    dayGiven = true;
    text = text.replace(wd[0], ' ');
  }
  // «il 2 novembre», «il due novembre», «il primo dicembre», «per il 21 giugno», «2 novembre».
  const dm = new RegExp(
    `\\s(?:(?:per\\s+il|entro\\s+il|il|l'|al|dal)\\s*)?(?<d>\\d{1,2}|${DAY_WORDS_RE})\\s+(?<mo>${MONTHS.join('|')})(?:\\s+(?<y>\\d{4}))?\\s`,
    'iu',
  ).exec(text);
  if (dm?.groups?.d && dm.groups.mo) {
    d = /^\d+$/.test(dm.groups.d)
      ? Number(dm.groups.d)
      : (DAY_WORDS[dm.groups.d.toLowerCase()] ?? 0);
    m = MONTHS.indexOf(dm.groups.mo.toLowerCase()) + 1;
    if (dm.groups.y) y = Number(dm.groups.y);
    else if (m < today.month || (m === today.month && d < today.day)) y = today.year + 1;
    dayGiven = true;
    text = text.replace(dm[0], ' ');
  }
  const dn = /\s(?:il\s+)?(?<d>\d{1,2})\/(?<m>\d{1,2})(?:\/(?<y>\d{2,4}))?\s/u.exec(text);
  if (dn?.groups?.d && dn.groups.m) {
    d = Number(dn.groups.d);
    m = Number(dn.groups.m);
    if (dn.groups.y)
      y = dn.groups.y.length === 2 ? 2000 + Number(dn.groups.y) : Number(dn.groups.y);
    else if (m < today.month || (m === today.month && d < today.day)) y = today.year + 1;
    dayGiven = true;
    text = text.replace(dn[0], ' ');
  }

  // Momenti della giornata (ora predefinita se non detta).
  const periods: Array<[RegExp, number]> = [
    [
      /\s(?:questa\s+mattina|stamattina|stamani|di\s+mattina|la\s+mattina|al\s+mattino|in\s+mattinata|mattina|mattino)\s/iu,
      9,
    ],
    [/\s(?:(?:questo|oggi|nel|di|il)\s+pomeriggio|pomeriggio)\s/iu, 15],
    [/\s(?:stasera|questa\s+sera|di\s+sera|la\s+sera|in\s+serata|sera)\s/iu, 20],
    [/\s(?:stanotte|questa\s+notte|di\s+notte)\s/iu, 23],
    [/\s(?:a\s+)?mezzogiorno\s/iu, 12],
    [/\s(?:a\s+)?mezzanotte\s/iu, 0],
  ];
  let periodHour: number | null = null;
  for (const [re, h] of periods) {
    const mm = re.exec(text);
    if (mm) {
      periodHour = h;
      text = text.replace(mm[0], ' ');
    }
  }

  // Ora: «alle 17», «alle 17:30», «alle 9 e mezza», «alle 7 di sera», «alle ore 8».
  const tm =
    /\s(?:alle|all'|per\s+le|verso\s+le|entro\s+le)\s*(?:ore\s+)?(?<h>\d{1,2})(?:[:.,](?<mi>\d{2}))?(?:\s+e\s+(?<frac>mezza|mezzo|un\s+quarto|tre\s+quarti))?(?:\s+(?<ap>di\s+mattina|del\s+mattino|di\s+pomeriggio|del\s+pomeriggio|di\s+sera|della\s+sera|di\s+notte))?\s/iu.exec(
      text,
    );
  if (tm?.groups?.h) {
    hour = Number(tm.groups.h);
    minute = tm.groups.mi ? Number(tm.groups.mi) : 0;
    const frac = tm.groups.frac?.toLowerCase();
    if (frac?.startsWith('mezz')) minute = 30;
    else if (frac === 'un quarto') minute = 15;
    else if (frac === 'tre quarti') minute = 45;
    const ap = tm.groups.ap?.toLowerCase() ?? '';
    if (
      (/sera|pomeriggio|notte/.test(ap) || (periodHour !== null && periodHour >= 15)) &&
      hour < 12
    )
      hour += 12;
    if (/mattin/.test(ap) && hour === 12) hour = 0;
    timeGiven = true;
    text = text.replace(tm[0], ' ');
  } else if (periodHour !== null) {
    hour = periodHour;
    // Mezzogiorno e mezzanotte sono orari esatti; mattina, pomeriggio, sera e notte sono stime da dichiarare.
    const label: Record<number, string> = {
      9: 'mattina',
      15: 'pomeriggio',
      20: 'sera',
      23: 'notte',
    };
    if (label[periodHour]) assumed.push(`le ${periodHour} per «${label[periodHour]}»`);
    timeGiven = true;
  }
  if (hour === null || hour > 23 || minute > 59) {
    if (dayGiven) {
      hour = 9;
      assumed.push('le 9, perché non hai detto l’ora');
    } else {
      return { needTime: clean(text) };
    }
  }
  let at = zonedToUtc(tz, y, m, d, hour, minute);
  if (at.getTime() <= now.getTime() + 30_000 && !dayGiven) {
    [y, m, d] = addDays(y, m, d, 1);
    at = zonedToUtc(tz, y, m, d, hour, minute);
    assumed.push('domani, perché oggi quell’ora è già passata');
  }
  if (at.getTime() <= now.getTime()) return null;
  return { text: clean(text), at, assumed, timeGiven } as Parsed;
}

/** Riconosce le richieste «ricordami…» e la gestione dei promemoria; null se non è di questo tipo. */
export function parseReminderCommand(
  input: string,
  now = new Date(),
  tz = 'Europe/Rome',
): ReminderPlan | null {
  const text = input
    .replace(/[‘’´`]/gu, "'")
    .trim()
    .replace(/[.!?]+$/gu, '')
    .trim();
  if (text.startsWith(REMINDER_FIRE_PREFIX)) {
    const body = text.slice(REMINDER_FIRE_PREFIX.length).trim();
    const from = /^\[da (?<from>[^\]]{1,60})\]\s*(?<rest>.+)$/su.exec(body);
    return from?.groups?.rest && from.groups.from
      ? { op: 'fire', text: from.groups.rest.trim(), from: from.groups.from.trim() }
      : { op: 'fire', text: body };
  }
  const lower = text.toLowerCase();
  if (!/ricorda|promemoria/u.test(lower)) return null;
  if (
    /^(?:che|quali|quanti)\s+promemoria|^(?:i\s+miei|mostra(?:mi)?(?:\s+i)?|elenca(?:mi)?(?:\s+i)?|dimmi\s+i|vedi(?:\s+i)?)\s+(?:miei\s+)?promemoria|^promemoria$|^cosa\s+(?:mi\s+)?devi\s+ricordar/iu.test(
      lower,
    )
  )
    return { op: 'list' };
  const cancel =
    /^(?:annulla|cancella|elimina|togli|rimuovi)\s+(?:il\s+|i\s+|tutti\s+i\s+)?promemoria(?:\s+(?<what>.+))?$/iu.exec(
      text,
    );
  if (cancel) return { op: 'cancel', what: clean(cancel.groups?.what ?? 'tutti') };
  // «ricorda a Giorgio di …», «promemoria per Giorgio: …»: a una persona collegata (Famiglia).
  const toOther =
    /(?:^|\s)(?:ricorda\s+a|promemoria\s+(?:per|a))\s+(?<who>\S+(?:\s+\S+)?)\s*(?::|,|\s+di\s|\s+che\s)\s*/iu.exec(
      text,
    );
  const who = toOther?.groups?.who?.replace(/[,:]+$/u, '').trim() || undefined;
  // «ricordami …» anche non in testa: «tra 20 minuti ricordami di …», «domani ricordami di …».
  const anchor =
    toOther ??
    /(?:^|\s)(?:ricordami|ricordati|ricorda(?:mi)?|promemoria)\s*(?::|di\s|che\s|,)?\s*/iu.exec(
      text,
    );
  if (!anchor) return null;
  const rest =
    `${text.slice(0, anchor.index)} ${text.slice(anchor.index + anchor[0].length)}`.trim();
  if (!rest) return null;
  const parsed = parseWhen(rest, now, tz);
  if (parsed === null) return null;
  if ('needTime' in parsed)
    return { op: 'ask_time', text: parsed.needTime, ...(who ? { who } : {}) };
  return {
    op: 'create',
    text: parsed.text,
    at: parsed.at,
    assumed: parsed.assumed,
    ...(who ? { who } : {}),
  };
}

/**
 * Risposta alla domanda «a che ora?»: il messaggio successivo è solo un orario («alle 9», «domani alle 8»,
 * «tra 10 minuti», «stasera»), eventualmente con parole di cortesia. Qualunque altro contenuto: null, la
 * domanda decade e il messaggio segue il percorso normale.
 */
export function reminderFollowUp(
  awaiting: unknown,
  input: string,
  now = new Date(),
  tz = 'Europe/Rome',
): ReminderPlan | null {
  const a = awaiting as { text?: unknown; who?: unknown } | null;
  if (!a || typeof a.text !== 'string' || !a.text.trim()) return null;
  const t = input
    .replace(/[‘’´`]/gu, "'")
    .replace(/[.!?]+$/gu, '')
    .trim();
  if (!t || t.split(/\s+/).length > 8 || /ricorda|promemoria/iu.test(t)) return null;
  const parsed = parseWhen(t, now, tz);
  if (!parsed || 'needTime' in parsed) return null;
  const residue = ` ${parsed.text.replace(/[,;:]+/gu, ' ')} `
    .replace(
      /(?:^|\s)(?:ok|okay|va\s+bene|grazie|per\s+favore|perfetto|sì|si|allora|facciamo|mettilo|mettila|direi)(?=\s|$)/giu,
      ' ',
    )
    .replace(/[\s,;:]+/gu, ' ')
    .trim();
  if (residue) return null;
  return {
    op: 'create',
    text: a.text,
    at: parsed.at,
    assumed: parsed.assumed,
    ...(typeof a.who === 'string' && a.who ? { who: a.who } : {}),
  };
}

export function formatWhen(at: Date, tz: string, now = new Date()): string {
  const p = localParts(at, tz);
  const t = localParts(now, tz);
  const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const sameDay = p.year === t.year && p.month === t.month && p.day === t.day;
  const [ty, tm, td] = addDays(t.year, t.month, t.day, 1);
  const tomorrow = p.year === ty && p.month === tm && p.day === td;
  if (sameDay) return `oggi alle ${hhmm}`;
  if (tomorrow) return `domani alle ${hhmm}`;
  const diffDays = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(t.year, t.month - 1, t.day)) / 86_400_000,
  );
  if (diffDays > 1 && diffDays < 7) return `${WEEKDAYS[p.weekday]} alle ${hhmm}`;
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}${p.year !== t.year ? ` ${p.year}` : ''} alle ${hhmm}`;
}

export function toRemindersBlock(
  reminders: readonly Reminder[],
  title = 'I tuoi promemoria',
): ContentBlock {
  return {
    kind: 'reminders',
    title,
    reminders: reminders.slice(0, 50).map((r) => ({
      id: r.id,
      text: r.text.slice(0, 300),
      at: r.at.toISOString(),
      status: r.status,
      ...(r.for ? { for: r.for.slice(0, 60) } : {}),
      ...(r.from ? { from: r.from.slice(0, 60) } : {}),
    })),
  };
}

export function createReminderSkill(
  store: ReminderStore | null,
  timezone = 'Europe/Rome',
): DeterministicSkill {
  return {
    id: 'ricordami',
    kind: 'deterministic',
    category: 'reminders',
    description:
      'Promemoria a giorno e ora: «ricordami di … alle 17», «domani alle 9», «tra 20 minuti»; anche a una persona collegata («ricorda a Giorgio di …»); elenco e annullamento.',
    examples: [
      'ricordami di uscire alle 17',
      'ricordami domani alle 9 di chiamare il dentista',
      'tra 20 minuti ricordami di spegnere il forno',
      'ricorda a Giorgio di chiamarmi domani alle 17',
      'che promemoria ho?',
    ],
    match: (text) => parseReminderCommand(text, new Date(), timezone),
    followUp: (awaiting, text) => reminderFollowUp(awaiting, text, new Date(), timezone),
    run: async (plan, ctx): Promise<SkillReply> => {
      const p = plan as ReminderPlan;
      switch (p.op) {
        case 'fire':
          return {
            text: p.from ? `⏰ Promemoria da ${p.from}: ${p.text}` : `⏰ Promemoria: ${p.text}`,
            actions: ['fire'],
          };
        case 'ask_time':
          return {
            text: `A che ora ${p.who ? `lo ricordo a ${p.who}` : 'te lo ricordo'}? Il promemoria è «${tidyReminderText(p.text)}». Dimmi per esempio «alle 17», «domani alle 9» o «tra 30 minuti».`,
            actions: [],
            // Il messaggio successivo («alle 9») completa questo promemoria.
            awaiting: { text: p.text, ...(p.who ? { who: p.who } : {}) },
          };
        case 'create': {
          if (!store)
            return { text: 'I promemoria non sono disponibili in questo contesto.', actions: [] };
          let r: Reminder;
          try {
            r = await store.create(ctx.userId, {
              text: p.text,
              at: p.at,
              timezone,
              ...(p.who ? { forLabel: p.who } : {}),
            });
          } catch (err) {
            if (err instanceof UnknownPersonError)
              return {
                text: `Non conosco nessun «${err.label}». Collega la sua installazione da Impostazioni → Famiglia (con un codice d'invito) e riprova.`,
                actions: [],
              };
            throw err;
          }
          // Le stime dette in una frase a parte, senza parentesi annidate.
          const note = p.assumed.length ? ` Ho inteso ${p.assumed.join(' e ')}.` : '';
          const what = lowerFirst(r.text);
          if (r.for)
            return {
              text: `⏰ Va bene: ricordo a ${r.for} di ${what} ${formatWhen(r.at, timezone)}.${note} Il promemoria arriva sul suo telefono.`,
              actions: [`create:${r.id}`],
              blocks: [toRemindersBlock([r], `Promemoria per ${r.for}`)],
            };
          return {
            text: `⏰ Va bene: ti ricordo di ${what} ${formatWhen(r.at, timezone)}.${note}`,
            actions: [`create:${r.id}`],
            blocks: [toRemindersBlock([r], 'Promemoria')],
          };
        }
        case 'list': {
          if (!store)
            return { text: 'I promemoria non sono disponibili in questo contesto.', actions: [] };
          const list = await store.list(ctx.userId);
          if (!list.length) return { text: 'Non hai promemoria in programma.', actions: ['list'] };
          return {
            text: `Hai ${list.length} promemoria: ${list
              .map(
                (r) =>
                  `${r.text}${r.for ? ` (per ${r.for})` : r.from ? ` (da ${r.from})` : ''} (${formatWhen(r.at, timezone)})`,
              )
              .join('; ')}.`,
            actions: ['list'],
            blocks: [toRemindersBlock(list)],
          };
        }
        case 'cancel': {
          if (!store)
            return { text: 'I promemoria non sono disponibili in questo contesto.', actions: [] };
          const list = await store.list(ctx.userId);
          if (!list.length) return { text: 'Non hai promemoria da annullare.', actions: [] };
          const what = p.what.toLowerCase();
          let targets: Reminder[];
          if (what === 'tutti' || what === 'tutto') targets = list;
          else {
            const hm = /(?:delle|alle)\s+(\d{1,2})(?:[:.](\d{2}))?/u.exec(what);
            targets = list.filter((r) => {
              if (hm) {
                const lp = localParts(r.at, timezone);
                return (
                  lp.hour === Number(hm[1]) && lp.minute === (hm[2] ? Number(hm[2]) : lp.minute)
                );
              }
              return r.text.toLowerCase().includes(what.replace(/^(di|del|della|dello)\s+/u, ''));
            });
          }
          if (!targets.length)
            return {
              text: `Nessun promemoria corrisponde a «${p.what}».`,
              actions: [],
              blocks: [toRemindersBlock(list)],
            };
          for (const r of targets) await store.remove(ctx.userId, r.id);
          const remaining = await store.list(ctx.userId);
          return {
            text: `Annullato: ${targets.map((r) => r.text).join(', ')}.`,
            actions: targets.map((r) => `cancel:${r.id}`),
            ...(remaining.length ? { blocks: [toRemindersBlock(remaining)] } : {}),
          };
        }
        default:
          return { text: 'Richiesta non riconosciuta.', actions: [] };
      }
    },
  };
}
