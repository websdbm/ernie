import type { ContentBlock } from '@ernie/protocol';
import {
  firstOccurrence,
  parseRepeat,
  type ReminderRepeat,
  repeatLabel,
} from './reminder-repeat.js';
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
  /** Quando suona; assente nei promemoria legati a un luogo. */
  readonly at?: Date;
  /** Promemoria geolocalizzato (15 ott 2026): scatta arrivando nel luogo (o lasciandolo). */
  readonly place?: ReminderPlace;
  readonly status: 'scheduled' | 'done' | 'cancelled';
  /** Promemoria messo da me a una persona collegata (Famiglia): la sua etichetta («Giorgio»). */
  readonly for?: string;
  /** Promemoria messo a me da una persona collegata: la sua etichetta («papà»). */
  readonly from?: string;
  /** Canali scelti per questo promemoria (v1.11); assenti = impostazioni generali. */
  readonly channels?: ReminderChannels;
  /** Ricorrenza (v1.11): `at` è la prossima occorrenza. */
  readonly repeat?: ReminderRepeat;
  /** Preavviso di un appuntamento (v1.13): `at` è l'ora dell'avviso, `eventAt` quella dell'appuntamento. */
  readonly eventAt?: Date;
}

export interface ReminderPlace {
  /** Etichetta del luogo nella scheda anagrafica («casa», «lavoro»). */
  readonly label: string;
  readonly on: 'arrive' | 'leave';
  /** Ogni volta, non solo la prossima. */
  readonly repeat?: boolean;
  /** Dalla scheda, per il telefono: assenti finché il luogo non ha indirizzo o posizione. */
  readonly placeId?: string;
  readonly address?: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly radius?: number;
}

export interface ReminderChannels {
  readonly email?: boolean;
  readonly alarm?: boolean;
}

/** «Ricorda a Giorgio…» senza un collegamento con quell'etichetta. */
export class UnknownPersonError extends Error {
  /** `suggestion`: un'etichetta collegata quasi uguale («papo» per «papi»), da proporre all'utente. */
  constructor(
    readonly label: string,
    readonly suggestion?: string,
  ) {
    super(`persona sconosciuta: ${label}`);
    this.name = 'UnknownPersonError';
  }
}

export interface ReminderStore {
  /** Con `forLabel` il promemoria va a una persona collegata (Famiglia); se non esiste: UnknownPersonError. */
  create(
    userId: string,
    input: {
      text: string;
      /** Ora del promemoria; assente se è legato a un luogo (`place`). */
      at?: Date;
      /** Promemoria geolocalizzato: scatta arrivando nel luogo della scheda (o lasciandolo). */
      place?: { label: string; on: 'arrive' | 'leave'; repeat?: boolean };
      timezone: string;
      forLabel?: string;
      /** Ricorrente: `at` è la prima occorrenza. */
      repeat?: ReminderRepeat;
      /** Canali chiesti a voce («mandamelo per email»). */
      channels?: ReminderChannels;
      /** Titolo da tenere com'è, senza riscriverlo con il modello (es. «Sveglia», scelta dell'utente). */
      literalTitle?: boolean;
      /** Appuntamento con preavviso: ora dell'appuntamento (l'avviso parte ad `at`, prima). */
      eventAt?: Date;
    },
  ): Promise<Reminder>;
  /** Promemoria futuri ancora attivi, dal più vicino. */
  list(userId: string): Promise<Reminder[]>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Cambia testo e/o ora (dalla scheda nell'app): restituisce il promemoria aggiornato (può avere un id nuovo). */
  update(
    userId: string,
    id: string,
    patch: { text?: string; at?: Date; channels?: ReminderChannels },
  ): Promise<Reminder | null>;
  /** Email della scheda anagrafica (per i promemoria via email); null se non c'è. */
  emailAddress?(userId: string): Promise<string | null>;
  /** Salva o sostituisce l'email nella scheda anagrafica (detta dall'utente). */
  setEmail?(userId: string, email: string): Promise<boolean>;
  /** Luogo della scheda per etichetta; null se non c'è (i promemoria per luogo chiedono l'indirizzo). */
  findPlace?(
    userId: string,
    label: string,
  ): Promise<{ label: string; address?: string; located: boolean; fromNote?: string } | null>;
  /** Salva l'indirizzo di un luogo nella scheda («casa mia è in via Roma 3»); null se non riesce. */
  setPlace?(
    userId: string,
    input: { label: string; address: string },
  ): Promise<{ label: string; address: string } | null>;
  /** «Salva questo posto come …»: posizione del telefono con un nome; null se non riesce. */
  setPlaceHere?(
    userId: string,
    input: { label: string; lat: number; lng: number; accuracyM?: number },
  ): Promise<{ label: string; moved: boolean } | null>;
  /** Cambia il nome di un luogo (e dei promemoria legati a lui). */
  renamePlace?(
    userId: string,
    from: string,
    to: string,
  ): Promise<
    | { ok: true; from: string; to: string; reminders: number }
    | { ok: false; reason: 'missing' | 'taken' | 'invalid' }
  >;
}

export type ReminderPlan =
  | {
      op: 'create';
      text: string;
      at: Date;
      assumed: string[];
      who?: string;
      repeat?: ReminderRepeat;
      /** «…e mandamelo per email»: canale email acceso su questo promemoria. */
      email?: boolean;
      /** «Svegliami alle 6»: suona come una sveglia sul telefono, senza email. */
      alarm?: boolean;
      /** «Ho il dentista alle 19, avvisami alle 18»: ora dell'appuntamento (l'avviso è `at`). */
      eventAt?: Date;
    }
  | { op: 'ask_time'; text: string; who?: string; email?: boolean; alarm?: boolean }
  | { op: 'set_email'; email: string }
  | {
      op: 'create_place';
      text: string;
      place: { label: string; on: 'arrive' | 'leave'; repeat: boolean };
      /** Nome più lungo («studio di giulia»): vale se è un luogo della scheda, con il suo testo. */
      alt?: { label: string; text: string };
    }
  /** «Salva questo posto come palestra»: la posizione del telefono con un nome. */
  | { op: 'name_here'; label: string }
  /** «Rinomina dentista in studio Rossi». */
  | { op: 'rename_place'; from: string; to: string }
  /** «Ricorda a Giorgio … quando arriva a casa»: per ora i promemoria per luogo valgono solo per sé. */
  | { op: 'place_other'; who?: string }
  | { op: 'set_place'; label: string; address: string }
  | { op: 'list' }
  | { op: 'cancel'; what: string }
  | { op: 'fire'; text: string; from?: string; lead?: string };

export const REMINDER_FIRE_PREFIX = '__promemoria__ ';

// ---------- luoghi ----------

// Con l'apostrofo il luogo segue attaccato («all'ufficio»); le altre preposizioni vogliono uno spazio dopo.
const PLACE_PREP =
  "(?:(?:all|dall|nell|sull)'|(?:allo|alla|al|ai|in|nello|nella|nel|dallo|dalla|dal|da|di|a)\\s+)";
const ARRIVE_VERBS =
  'arrivo|arriverò|arrivero|sono|sarò|saro|torno|tornerò|tornero|rientro|rientrerò|rientrero|entro|entrerò|passo|vado';
const LEAVE_VERBS =
  'esco|uscirò|usciro|lascio|lascerò|lascero|parto|partirò|partiro|vado\\s+via|me\\s+ne\\s+vado';
const OTHER_VERBS = 'arriva|arriverà|torna|tornerà|rientra|esce|uscirà|lascia|parte|è|sarà';
/** Come PLACE_RE, ma il luogo può contenere «di» («allo studio di Giulia»): alternativa da verificare sulla scheda. */
const PLACE_RE_LONG = new RegExp(
  `(?<when>ogni\\s+volta\\s+che|tutte\\s+le\\s+volte\\s+che|non\\s+appena|quando|appena)\\s+(?<verb>${LEAVE_VERBS}|${ARRIVE_VERBS}|${OTHER_VERBS})\\s+(?<prep>${PLACE_PREP})(?<place>[\\p{L}][\\p{L}']*(?:\\s+[\\p{L}']+){0,4}?)(?=\\s*(?:[,.;:!?]|$)|\\s+(?:ricordami|ricordamelo|ricorda|ricordati|mi|e)\\s)`,
  'iu',
);

const PLACE_RE = new RegExp(
  `(?<when>ogni\\s+volta\\s+che|tutte\\s+le\\s+volte\\s+che|non\\s+appena|quando|appena)\\s+(?<verb>${LEAVE_VERBS}|${ARRIVE_VERBS}|${OTHER_VERBS})\\s+(?<prep>${PLACE_PREP})(?<place>[\\p{L}][\\p{L}']*(?:\\s+[\\p{L}']+){0,2}?)(?=\\s*(?:[,.;:!?]|$)|\\s+(?:ricordami|ricordamelo|ricorda|ricordati|di|che|e|mi)\\s)`,
  'iu',
);

/** Indirizzi espliciti (via, piazza…): un numero da solo può essere una data o un orario. */
export function addressLike(raw: string): string | undefined {
  const t = raw
    .replace(/[‘’´`]/gu, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:è|e'|in|a|al|alla|nel|nella|si\s+trova\s+in)\s+/iu, '')
    .replace(/[.!]+$/u, '')
    .trim();
  if (t.length < 5 || t.length > 160) return undefined;
  if (
    /^(?:via|viale|v\.le|piazza|p\.za|piazzale|corso|c\.so|strada|vicolo|largo|località|loc\.|contrada|frazione|borgo|lungomare|lungotevere)\s+\S/iu.test(
      t,
    )
  )
    return t;
  return undefined;
}

/** Preposizioni per i luoghi più comuni: «a casa» / «di casa», «al lavoro» / «dal lavoro»… */
const PLACE_WORDS: Record<string, readonly [string, string]> = {
  casa: ['a casa', 'di casa'],
  lavoro: ['al lavoro', 'dal lavoro'],
  ufficio: ['in ufficio', "dall'ufficio"],
  scuola: ['a scuola', 'da scuola'],
  palestra: ['in palestra', 'dalla palestra'],
  università: ["all'università", "dall'università"],
  stazione: ['in stazione', 'dalla stazione'],
  supermercato: ['al supermercato', 'dal supermercato'],
  piscina: ['in piscina', 'dalla piscina'],
  farmacia: ['in farmacia', 'dalla farmacia'],
  banca: ['in banca', 'dalla banca'],
  posta: ['alla posta', 'dalla posta'],
  chiesa: ['in chiesa', 'dalla chiesa'],
  ospedale: ["all'ospedale", "dall'ospedale"],
  aeroporto: ["all'aeroporto", "dall'aeroporto"],
  asilo: ["all'asilo", "dall'asilo"],
  parcheggio: ['al parcheggio', 'dal parcheggio'],
  bar: ['al bar', 'dal bar'],
  ristorante: ['al ristorante', 'dal ristorante'],
  negozio: ['al negozio', 'dal negozio'],
  studio: ['allo studio', 'dallo studio'],
  garage: ['in garage', 'dal garage'],
  mare: ['al mare', 'dal mare'],
  montagna: ['in montagna', 'dalla montagna'],
  campagna: ['in campagna', 'dalla campagna'],
  centro: ['in centro', 'dal centro'],
};

/** Persone e professioni: si va «dal dentista», «dalla nonna», «dai nonni», non «a dentista». */
const PERSON_PLACE =
  /^(?:\p{L}+ista|medico|dottore|dottoressa|parrucchiere|parrucchiera|barbiere|meccanico|veterinario|avvocato|notaio|fisioterapista|psicologo|psicologa|nonno|nonna|nonni|zio|zia|zii|mamma|papà|papa|suocera|suocero|suoceri|amico|amica|amici)$/u;

/** Preposizioni per un luogo che è una persona: «dal dentista», «dallo psicologo», «dalla nonna», «dai nonni». */
function personPreposition(label: string): string {
  if (/^(?:nonni|zii|suoceri|amici)$/u.test(label)) return `dai ${label}`;
  if (/a$/u.test(label) && !/ista$/u.test(label)) return `dalla ${label}`;
  if (/^(?:s[^aeiou]|z|ps|gn)/u.test(label)) return `dallo ${label}`;
  return `dal ${label}`;
}

/** «quando arrivi a casa», «ogni volta che esci dal lavoro» (seconda persona, per le risposte). */
export function placePhrase(place: Pick<ReminderPlace, 'label' | 'on' | 'repeat'>): string {
  const person = PERSON_PLACE.test(place.label) ? personPreposition(place.label) : null;
  const [to, from] = person
    ? [person, person]
    : // Nomi scelti dall'utente («studio di giulia»): tra virgolette, senza indovinare l'articolo.
      (PLACE_WORDS[place.label] ?? [`a «${place.label}»`, `da «${place.label}»`]);
  const when = place.repeat ? 'ogni volta che' : 'quando';
  return place.on === 'leave' ? `${when} esci ${from}` : `${when} arrivi ${to}`;
}

/** Etichetta breve dal luogo detto: «casa mia» → «casa», «l'ufficio» → «ufficio». */
function placeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(?:l'|la\s+|il\s+|lo\s+)/u, '')
    .replace(/\s+(?:mia|mio|nostra|nostro)$/u, '')
    .replace(/^(?:mia|mio|nostra|nostro)\s+/u, '')
    .trim();
}

/**
 * «Ricordami di … quando arrivo a casa», «quando esco dal lavoro ricordami …», «ogni volta che arrivo in palestra…».
 * null se la frase non lega il promemoria a un luogo.
 */
export function parsePlaceReminder(text: string): ReminderPlan | null {
  const m = PLACE_RE.exec(text);
  if (!m?.groups?.verb || !m.groups.place) return null;
  const verb = m.groups.verb.toLowerCase().replace(/\s+/g, ' ');
  const toOther = /(?:^|\s)(?:ricorda\s+a|promemoria\s+(?:per|a))\s+(?<who>\S+)/iu.exec(text)
    ?.groups?.who;
  if (new RegExp(`^(?:${OTHER_VERBS})$`, 'iu').test(verb) || toOther)
    return { op: 'place_other', ...(toOther ? { who: toOther.replace(/[,:]+$/u, '') } : {}) };
  const on: 'arrive' | 'leave' = new RegExp(`^(?:${LEAVE_VERBS})$`, 'iu').test(verb)
    ? 'leave'
    : 'arrive';
  const repeat = /ogni|tutte/iu.test(m.groups.when ?? '');
  const label = placeLabel(m.groups.place);
  if (!label) return null;
  const restOf = (mm: RegExpExecArray) =>
    `${text.slice(0, mm.index)} ${text.slice(mm.index + mm[0].length)}`
      .replace(
        /(?:^|\s)(?:ricordami|ricordamelo|ricordati|ricorda(?:mi)?|promemoria)\s*(?::|,)?\s*/iu,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:di|che|,)\s+/iu, '')
      .replace(/[,;:\s]+$/u, '')
      .trim();
  const rest = restOf(m);
  if (!rest) return null;
  // Nome più lungo con «di» («studio di Giulia»): si usa se nella scheda c'è un luogo con quel nome.
  const long = PLACE_RE_LONG.exec(text);
  const longLabel = long?.groups?.place ? placeLabel(long.groups.place) : '';
  const longRest = long ? restOf(long) : '';
  const alt =
    long && longLabel && longLabel !== label && longLabel.startsWith(label) && longRest
      ? { label: longLabel, text: longRest }
      : undefined;
  return { op: 'create_place', text: rest, place: { label, on, repeat }, ...(alt ? { alt } : {}) };
}

/** Nome dato dall'utente a un luogo: senza virgolette e punto finale, al più 40 caratteri. */
function spokenLabel(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/^[«"“'‘]+|[»"”'’.!]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

const HERE =
  '(?:questo\\s+(?:posto|luogo|indirizzo)|qui|qua|(?:il\\s+posto\\s+)?dove\\s+sono(?:\\s+(?:adesso|ora))?|la\\s+mia\\s+posizione(?:\\s+attuale)?)';
const AS = '(?:come|con\\s+il\\s+nome(?:\\s+di)?|col\\s+nome(?:\\s+di)?|:)';

/**
 * Dare un nome a un luogo in chat: «salva questo posto come palestra», «questo posto si chiama casa al mare»,
 * «chiama studio Rossi il posto in via Verdi 10», «salva via Verdi 10, Milano come studio di Giulia»,
 * «rinomina dentista in studio Rossi». null se la frase non è di questo tipo.
 */
export function parsePlaceNaming(text: string): ReminderPlan | null {
  const t = text.replace(/[‘’´`]/gu, "'").trim();
  const here =
    new RegExp(
      `^(?:salva|memorizza|segna|registra|chiama|etichetta|nomina)\\s+${HERE}\\s+${AS}?\\s*(?<label>.+)$`,
      'iu',
    ).exec(t) ??
    new RegExp(
      `^${HERE}\\s+(?:si\\s+chiama|lo\\s+chiamo|chiamalo|è|e')\\s+(?<label>.+)$`,
      'iu',
    ).exec(t) ??
    new RegExp(`^(?:chiama|etichetta)\\s+(?<label>.+?)\\s+${HERE}$`, 'iu').exec(t);
  if (here?.groups?.label) {
    const label = spokenLabel(here.groups.label);
    return label ? { op: 'name_here', label } : null;
  }
  const rename =
    /^(?:rinomina|cambia\s+(?:il\s+)?nome\s+(?:a|al|alla|del|della)?)\s*(?:il\s+luogo\s+|il\s+posto\s+|luogo\s+)?(?<from>.+?)\s+(?:in|come|con)\s+(?<to>.+)$/iu.exec(
      t,
    );
  if (rename?.groups?.from && rename.groups.to) {
    const from = spokenLabel(rename.groups.from);
    const to = spokenLabel(rename.groups.to);
    return from && to ? { op: 'rename_place', from, to } : null;
  }
  const addrAs =
    new RegExp(
      `^(?:salva|memorizza|segna|chiama|etichetta)\\s+(?:il\\s+posto\\s+(?:in|di|a)\\s+|l'indirizzo\\s+)?(?<addr>.+?)\\s+${AS}\\s*(?<label>.+)$`,
      'iu',
    ).exec(t) ??
    /^(?:chiama|etichetta)\s+(?<label>.+?)\s+(?:il\s+posto|l'indirizzo|il\s+luogo)\s+(?:in|di|a)\s+(?<addr>.+)$/iu.exec(
      t,
    );
  if (addrAs?.groups?.addr && addrAs.groups.label) {
    const address = addressLike(addrAs.groups.addr);
    const label = spokenLabel(addrAs.groups.label);
    if (address && label) return { op: 'set_place', label, address };
  }
  return null;
}

/** «Casa mia è in via Roma 3, Treviso», «abito in via…», «il mio ufficio è in piazza…». */
function parsePlaceStatement(text: string): ReminderPlan | null {
  const m =
    /^(?:(?:la\s+|il\s+|lo\s+|l')?(?<mine>mia\s+|mio\s+|nostra\s+|nostro\s+)?(?<label>[\p{L}'][\p{L}' ]{1,38}?)(?<mine2>\s+(?:mia|mio|nostra|nostro))?\s+(?:è|e'|si\s+trova|sta)\s+|(?:io\s+)?(?<abito>abito|vivo)\s+)(?<addr>.+)$/iu.exec(
      text,
    );
  if (!m?.groups?.addr) return null;
  const address = addressLike(m.groups.addr);
  if (!address) return null;
  if (m.groups.abito) return { op: 'set_place', label: 'casa', address };
  const label = placeLabel(m.groups.label ?? '');
  // Un nome qualsiasi solo se è chiaramente un luogo suo («la mia palestra», «lo studio di Giulia») o uno dei
  // soliti: «la riunione è in via Roma 3» non deve diventare un luogo.
  const known =
    /^(?:casa|ufficio|lavoro|palestra|scuola|università|universita|studio|negozio|bottega|laboratorio|garage|cantina|campagna|seconda casa|casa al mare|casa in montagna)$/u;
  const ok = known.test(label) || !!m.groups.mine || !!m.groups.mine2 || /\sdi\s/u.test(label);
  return label && ok ? { op: 'set_place', label, address } : null;
}

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

/** Ore in lettere dopo «alle», «per le», «verso le»: «per le sei» → «per le 6», «all'una» → «all'1». */
const HOUR_WORDS: Record<string, number> = {
  una: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
  tredici: 13,
  quattordici: 14,
  quindici: 15,
  sedici: 16,
  diciassette: 17,
  diciotto: 18,
  diciannove: 19,
  venti: 20,
  ventuno: 21,
  ventidue: 22,
  ventitré: 23,
  ventitre: 23,
};
const HOUR_WORDS_RE = Object.keys(HOUR_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

export function normalizeHourWords(text: string): string {
  return text.replace(
    new RegExp(
      `(?<pre>(?:^|\\s)(?:alle|all'|per\\s+le|verso\\s+le|entro\\s+le|le\\s+ore|ore))\\s*(?<w>${HOUR_WORDS_RE})(?=[\\s,.;!?]|$)`,
      'giu',
    ),
    (_m, pre: string, w: string) => `${pre} ${HOUR_WORDS[w.toLowerCase()] ?? w}`,
  );
}

interface Parsed {
  readonly text: string;
  readonly at: Date;
  readonly assumed: string[];
  /** L'ora è stata detta (non è un relativo «tra 20 minuti» né una stima da giorno senza ora). */
  readonly timeGiven?: boolean;
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
  /** Sveglie: «alle 5» è di mattina, non si sposta al pomeriggio. */
  opts: { morning?: boolean } = {},
): Parsed | { needTime: string } | null {
  let text = ` ${normalizeHourWords(rest.replace(/[‘’´`]/gu, "'"))} `;
  const assumed: string[] = [];
  const today = localParts(now, tz);
  let [y, m, d] = [today.year, today.month, today.day];
  let dayGiven = false;
  /** «Tra 3 giorni» senza ora: la stessa ora di adesso, non le 9. */
  let keepClock = false;
  let hour: number | null = null;
  let minute = 0;
  let timeGiven = false;

  // Relativo breve: «tra mezz'ora», «fra un quarto d'ora», «tra tre quarti d'ora».
  const half =
    /\s(?:tra|fra)\s+(?:(?<q>un\s+quarto|tre\s+quarti)\s+d'\s*ora|(?<h>mezz'\s*ora|mezzora))(?=[\s,.;!?])/iu.exec(
      text,
    );
  if (half?.groups) {
    const min = half.groups.h ? 30 : /^tre/iu.test(half.groups.q ?? '') ? 45 : 15;
    text = text.replace(half[0], ' ');
    return { text: clean(text), at: new Date(now.getTime() + min * 60_000), assumed };
  }
  // Relativo: «tra 20 minuti», «fra un'ora e mezza», «tra 2 ore e 30 minuti», «tra 10 min», «tra 3 giorni»,
  // «tra una settimana», «tra un mese».
  const rel = new RegExp(
    `\\s(?:tra|fra)\\s+${qty('n')}\\s*(?<u>min(?:ut[oi])?|or[ae]|giorn[oi]|settiman[ae]|mes[ei])(?:\\s+e\\s+(?:(?<half>mezz[oa])|${qty('n2')}\\s*(?:min(?:ut[oi])?)))?(?=[\\s,.;!?])`,
    'iu',
  ).exec(text);
  if (rel?.groups) {
    const n = qtyValue(rel.groups.n);
    const u = (rel.groups.u ?? '').toLowerCase();
    text = text.replace(rel[0], ' ');
    if (u.startsWith('min') || u.startsWith('or')) {
      const unit = u.startsWith('min') ? 60_000 : 3_600_000;
      const ms =
        n * unit +
        (rel.groups.half ? unit / 2 : 0) +
        (rel.groups.n2 ? qtyValue(rel.groups.n2) * 60_000 : 0);
      return { text: clean(text), at: new Date(now.getTime() + ms), assumed };
    }
    // Giorni, settimane, mesi: sul calendario (il cambio dell'ora non sposta l'orario), con l'ora detta se c'è.
    if (u.startsWith('mes')) [y, m, d] = addMonths(y, m, d, n);
    else [y, m, d] = addDays(y, m, d, u.startsWith('sett') ? n * 7 : n);
    dayGiven = true;
    keepClock = true;
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
      // «domattina» = domani mattina: il giorno qui, la mattina (ora predefinita 9) la danno i momenti della giornata.
      /\sdomattina\s/iu,
      () => {
        [y, m, d] = addDays(y, m, d, 1);
        dayGiven = true;
        text = text.replace(/\sdomattina\s/iu, ' mattina ');
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
  // Giorni della settimana anche senza accento («lunedi»), come si scrive in fretta o arriva dalla dettatura.
  const wd = new RegExp(
    `\\s(?:(?:il|al|per|di)\\s+)?(?:prossim[oa]\\s+)?(?<w>${WEEKDAYS.map((w) => w.replace(/ì$/u, '[iìí]')).join('|')})(?:\\s+prossim[oa])?\\s`,
    'iu',
  ).exec(text);
  if (wd?.groups?.w) {
    const target = WEEKDAYS.indexOf(wd.groups.w.toLowerCase().replace(/[ií]$/u, 'ì'));
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
  // «il 23 alle 10»: solo il giorno, di questo mese se non è passato, altrimenti del prossimo.
  if (!dayGiven) {
    const dOnly = /\s(?:per\s+il|entro\s+il|il)\s+(?<d>\d{1,2}|primo)\s/iu.exec(text);
    if (dOnly?.groups?.d) {
      d = dOnly.groups.d.toLowerCase() === 'primo' ? 1 : Number(dOnly.groups.d);
      if (d < today.day) [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
      dayGiven = true;
      text = text.replace(dOnly[0], ' ');
    }
  }
  // Data impossibile («31 novembre», «15/13»): meglio non indovinare, ci pensa il modello.
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;

  // Ora: «alle 17», «alle 17:30», «alle 9 e mezza», «alle 18 e 30», «alle 6 meno un quarto», «alle 7 di sera»,
  // «alle 8 del mattino». Prima dei momenti della giornata, così «del mattino» resta attaccato all'ora.
  const tm = new RegExp(
    `\\s(?:alle|all'|per\\s+le|verso\\s+le|entro\\s+le)\\s*(?:ore\\s+)?(?<h>\\d{1,2})(?:[:.,](?<mi>\\d{2}))?(?:\\s+e\\s+(?:(?<frac>mezza|mezzo|un\\s+quarto|tre\\s+quarti)|(?<emin>\\d{1,2}|${MINUTE_WORDS_RE})(?:\\s+minuti)?))?(?:\\s+meno\\s+(?<meno>un\\s+quarto|\\d{1,2}|${MINUTE_WORDS_RE})(?:\\s+minuti)?)?(?:\\s+(?<ap>di\\s+mattina|del\\s+mattino|di\\s+pomeriggio|del\\s+pomeriggio|di\\s+sera|della\\s+sera|di\\s+notte|della\\s+notte))?\\s`,
    'iu',
  ).exec(text);
  let ap = '';
  if (tm?.groups?.h) {
    hour = Number(tm.groups.h);
    minute = tm.groups.mi ? Number(tm.groups.mi) : 0;
    const frac = tm.groups.frac?.toLowerCase();
    if (frac?.startsWith('mezz')) minute = 30;
    else if (frac === 'un quarto') minute = 15;
    else if (frac === 'tre quarti') minute = 45;
    if (tm.groups.emin) minute = minuteValue(tm.groups.emin);
    if (tm.groups.meno) {
      const less = /quarto/iu.test(tm.groups.meno) ? 15 : minuteValue(tm.groups.meno);
      if (less > 0 && less < 60) {
        hour = (hour + 23) % 24;
        minute = 60 - less;
      }
    }
    ap = tm.groups.ap?.toLowerCase() ?? '';
    timeGiven = true;
    text = text.replace(tm[0], ' ');
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

  let smallHour = false;
  if (hour !== null) {
    // «Di notte» / «stanotte»: le ore piccole restano piccole («alle 2 di notte» = 02:00), «alle 11 di notte» = 23.
    const night = /notte/.test(ap) || periodHour === 23;
    if (night) {
      if (hour >= 9 && hour < 12) hour += 12;
    } else if (
      (/sera|pomeriggio/.test(ap) || (periodHour !== null && periodHour >= 15)) &&
      hour < 12
    )
      hour += 12;
    if (/mattin/.test(ap) && hour === 12) hour = 0;
    smallHour = !opts.morning && !ap && periodHour === null && hour >= 1 && hour <= 7;
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
  if (hour === null && keepClock) {
    hour = today.hour;
    minute = today.minute;
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
  // «Alle 4» senza mattina o pomeriggio: se le 4 sono passate e le 16 no, sono le 16; con un giorno detto
  // («domani alle 3») dall'una alle cinque è più probabile il pomeriggio.
  // Senza giorno: se l'ora del mattino è ancora da venire oggi resta quella (alle 2 di notte «alle 4» = 04:00),
  // altrimenti è il pomeriggio, oggi o domani («all'una» detto alle 15 = domani alle 13).
  if (smallHour) {
    const passed = at.getTime() <= now.getTime() + 30_000;
    if ((!dayGiven && passed) || (dayGiven && hour <= 5)) {
      hour += 12;
      at = zonedToUtc(tz, y, m, d, hour, minute);
      assumed.push(
        `le ${hour}${minute ? `:${String(minute).padStart(2, '0')}` : ''} del pomeriggio`,
      );
    }
  }
  if (at.getTime() <= now.getTime() + 30_000 && !dayGiven) {
    [y, m, d] = addDays(y, m, d, 1);
    at = zonedToUtc(tz, y, m, d, hour, minute);
    assumed.push('domani, perché oggi quell’ora è già passata');
  }
  if (at.getTime() <= now.getTime()) return null;
  return { text: clean(text), at, assumed, timeGiven } as Parsed;
}

/** Quantità nei relativi: cifre o parole («un'», «due», «dieci»…). */
function qty(name: string): string {
  return `(?<${name}>\\d+|un'|una|un|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|quindici|venti|trenta|quarantacinque|sessanta)`;
}
function qtyValue(raw: string | undefined): number {
  const t = (raw ?? '').toLowerCase();
  return /^\d+$/.test(t) ? Number(t) : (NUM_WORDS[t] ?? 1);
}
/** Minuti in lettere dopo «e» o «meno»: «e trenta», «meno dieci». */
const MINUTE_WORDS: Record<string, number> = {
  cinque: 5,
  dieci: 10,
  quindici: 15,
  venti: 20,
  venticinque: 25,
  trenta: 30,
  trentacinque: 35,
  quaranta: 40,
  quarantacinque: 45,
  cinquanta: 50,
  cinquantacinque: 55,
};
const MINUTE_WORDS_RE = Object.keys(MINUTE_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');
function minuteValue(raw: string): number {
  const t = raw.toLowerCase();
  return /^\d+$/.test(t) ? Number(t) : (MINUTE_WORDS[t] ?? 0);
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Stesso giorno fra `n` mesi (il 31 diventa l'ultimo del mese se serve). */
function addMonths(y: number, m: number, d: number, n: number): [number, number, number] {
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return [ny, nm, Math.min(d, daysInMonth(ny, nm))];
}

/** Riconosce le richieste «ricordami…» e la gestione dei promemoria; null se non è di questo tipo. */
export function parseReminderCommand(
  input: string,
  now = new Date(),
  tz = 'Europe/Rome',
): ReminderPlan | null {
  const plan = parseSingleReminderCommand(input, now, tz);
  if (!plan || (plan.op !== 'create' && plan.op !== 'create_place' && plan.op !== 'ask_time'))
    return plan;
  // Le routine fattuali possono contenere giorni e ore senza chiedere alcun avviso.
  // Queste formulazioni richiedono il contesto del modello e della memoria, non il percorso rapido.
  if (
    /(?:^|\s)ricorda(?:ti)?\s+che\s/iu.test(input) ||
    /\b(?:senza|niente)\s+(?:(?:alcun[oa]?|nessun[oa]?|le|i|gli)\s+)?(?:notifiche?|promemoria|avvisi)|\bnon\s+(?:notificarmi|avvisarmi)|\bnon\s+(?:voglio|creare|crearmi|inviare|inviarmi)\s+(?:(?:alcun[oa]?|nessun[oa]?|le|i|gli|dei|delle)\s+)?(?:notifiche?|promemoria|avvisi)/iu.test(
      input,
    ) ||
    /\b(?:salva|memorizza|registra|aggiorna)\b[^.!?]*\bsecond\s+brain\b/iu.test(input)
  )
    return null;
  const body = plan.text;
  // Il parser rapido può rappresentare un solo impegno. Una seconda richiesta o un vincolo
  // ancora nel titolo deve arrivare al modello, anche se Jev non è disponibile.
  if (
    /(?:^|\s)(?:ricordami|ricordati|ricordamelo|avvisami|avvertimi|promemoria)(?=[\s,.;:!?]|$)/iu.test(
      body,
    ) ||
    /(?:^|\s)(?:entro|prima\s+delle|non\s+oltre)\s+(?:le\s+|ore\s+)?\d/iu.test(
      normalizeHourWords(input),
    )
  )
    return null;
  const remainder = parseWhen(body, now, tz);
  if (remainder && !('needTime' in remainder)) return null;
  return plan;
}

function parseSingleReminderCommand(input: string, now: Date, tz: string): ReminderPlan | null {
  const text = input
    .replace(/[‘’´`]/gu, "'")
    .trim()
    .replace(/[.!?]+$/gu, '')
    .trim();
  if (text.startsWith(REMINDER_FIRE_PREFIX)) {
    let body = text.slice(REMINDER_FIRE_PREFIX.length).trim();
    let from: string | undefined;
    let lead: string | undefined;
    // Etichette in testa, in qualsiasi ordine: «[da papà]» (Famiglia) e «[tra un'ora]» (preavviso di un appuntamento).
    for (;;) {
      const tag = /^\[(?<k>da|tra) (?<v>[^\]]{1,60})\]\s*/u.exec(body);
      if (!tag?.groups?.v) break;
      if (tag.groups.k === 'da') from = tag.groups.v.trim();
      else lead = `tra ${tag.groups.v.trim()}`;
      body = body.slice(tag[0].length);
    }
    return { op: 'fire', text: body, ...(from ? { from } : {}), ...(lead ? { lead } : {}) };
  }
  const lower = text.toLowerCase();
  // «La mia email è …», «cambia la mia email in …», «usa … come email»: va nella scheda anagrafica.
  const said =
    /(?:la\s+mia\s+(?:e-?mail|mail|posta)\s+(?:è|e'|sarà|diventa)|cambia\s+(?:la\s+)?(?:mia\s+)?(?:e-?mail|mail)\s+(?:in|con)|(?:la\s+)?(?:nuova\s+)?(?:e-?mail|mail)\s+(?:per\s+i\s+promemoria\s+)?è)\s*:?\s*(?<e>\S+@\S+)/iu.exec(
      text,
    );
  const saidAs = /usa\s+(?<e>\S+@\S+)\s+come\s+(?:(?:la\s+)?mia\s+)?(?:e-?mail|mail)/iu.exec(text);
  const stated = normalizeEmailAddress(said?.groups?.e ?? saidAs?.groups?.e);
  if (stated) return { op: 'set_email', email: stated };
  const named = parsePlaceNaming(text);
  if (named) return named;
  const placeStated = parsePlaceStatement(text);
  if (placeStated) return placeStated;
  const wake = parseWakeUp(text, now, tz);
  if (wake) return wake;
  const appointment = parseAppointment(text, now, tz);
  if (appointment) return appointment;
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
  // «…quando arrivo a casa»: legato a un luogo della scheda, senza ora.
  const placed = parsePlaceReminder(text);
  if (placed) return placed;
  // «ricorda a Giorgio di …», «promemoria per Giorgio: …»: a una persona collegata (Famiglia).
  // Con l'orario fra il nome e «di» («ricorda a Giorgio tra 5 minuti di …») basta il nome: prima finiva all'utente.
  const toOther =
    /(?:^|\s)(?:ricorda\s+(?:a|al|alla|allo|ai|alle|all')|promemoria\s+(?:per|a))\s*(?<who>(?<=\s|')\S+(?:\s+\S+)?)\s*(?::|,|\s+di\s|\s+che\s)\s*/iu.exec(
      text,
    ) ??
    /(?:^|\s)(?:ricorda\s+a|promemoria\s+(?:per|a))\s+(?<who>(?!(?:lui|lei|loro|me|te|noi|voi)(?=[\s,.;:!?]|$))\p{L}[\p{L}'’]*)(?=[\s,.;:!?])\s*/iu.exec(
      text,
    );
  const who = toOther?.groups?.who?.replace(/[,:]+$/u, '').trim() || undefined;
  // «Ricordagli / ricordale / digli di …»: la persona viene dal discorso prima (segnalato il 15 ott 2026: «allora
  // ricordagli fra cinque minuti…» era finito all'utente). La skill non ha il contesto: decide il modello.
  if (
    !toOther &&
    /(?:^|\s)(?:ricord(?:agli|ale|aglielo|agliela|ateglielo|alo\s+a\s+lui|alo\s+a\s+lei)|ricorda\s+a\s+(?:lui|lei|loro)|digli|dille|avvisalo|avvisala)(?=[\s,.;:!?]|$)/iu.test(
      text,
    )
  )
    return null;
  // «ricordami …» anche non in testa: «tra 20 minuti ricordami di …», «domani ricordami di …». La parola deve
  // finire lì: «ricorda» dentro «ricordagli» non vale.
  const anchor =
    toOther ??
    /(?:^|\s)(?:ricordami|ricordati|ricorda(?:mi)?)(?=[\s,.;:!?]|$)\s*(?::|di\s|che\s|,)?\s*/iu.exec(
      text,
    ) ??
    // Il sostantivo da solo non è un comando: «lista senza orari né promemoria»
    // deve arrivare alla skill Todo, non generare un nuovo promemoria.
    /^(?:ernie[,\s]+)?(?:(?:crea(?:mi)?|imposta(?:mi)?|fammi|mettimi|aggiungi(?:mi)?)\s+(?:un\s+)?)?promemoria(?=[\s,.;:!?]|$)\s*(?::|di\s|che\s|,)?\s*/iu.exec(
      text,
    );
  if (!anchor) return null;
  const joined =
    `${text.slice(0, anchor.index)} ${text.slice(anchor.index + anchor[0].length)}`.trim();
  // «…e mandamelo per email», «anche via mail»: canale email su questo promemoria.
  const emailAsk =
    /\s(?:(?:e\s+)?(?:mandamelo|mandami(?:\s+una)?|inviamelo|scrivimi)\s+(?:anche\s+)?(?:per|via|una|in)?\s*(?:e-?mail|mail|posta)|(?:anche\s+|pure\s+)?(?:per|via|tramite|con\s+una)\s+(?:e-?mail|mail|posta(?:\s+elettronica)?))(?=\s|$)/iu;
  const email = emailAsk.test(` ${joined} `);
  const rest = email ? ` ${joined} `.replace(emailAsk, ' ').replace(/\s+/g, ' ').trim() : joined;
  if (!rest) return null;
  // Ricorrenti: «ogni venerdì alle 9», «ogni giorno alle 8», «il 5 di ogni mese».
  const rep = parseRepeat(rest);
  if (rep)
    return {
      op: 'create',
      text: rep.text,
      at: firstOccurrence(rep.repeat, now, tz),
      assumed: rep.assumed,
      repeat: rep.repeat,
      ...(who ? { who } : {}),
      ...(email ? { email } : {}),
    };
  // Ricorrenza riconosciuta ma non rappresentabile: niente fallback a un avviso singolo.
  if (
    /\b(?:ogni|tutti\s+i\s+giorni|tutte\s+le\s+(?:mattine|sere)|giorni\s+feriali|dal\s+luned[ìi]\s+al\s+venerd[ìi])\b/iu.test(
      rest,
    )
  )
    return null;
  const parsed = parseWhen(rest, now, tz);
  if (parsed === null) return null;
  // «Ricordati che sono allergico alle noci», senza un quando: è un ricordo, non un promemoria (lo gestisce la
  // memoria del modello).
  if ('needTime' in parsed && /(?:^|\s)ricordati\s+che\s/iu.test(text)) return null;
  if ('needTime' in parsed)
    return {
      op: 'ask_time',
      text: parsed.needTime,
      ...(who ? { who } : {}),
      ...(email ? { email } : {}),
    };
  return {
    op: 'create',
    text: parsed.text,
    at: parsed.at,
    assumed: parsed.assumed,
    ...(who ? { who } : {}),
    ...(email ? { email } : {}),
  };
}

/** Quantità di tempo di un preavviso: «un'ora», «30 minuti», «2 ore», «un giorno». */
export function leadQuantity(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min === 1) return 'un minuto';
  if (min < 60) return `${min} minuti`;
  if (min === 90) return "un'ora e mezza";
  if (min % 1440 === 0) return min === 1440 ? 'un giorno' : `${min / 1440} giorni`;
  if (min % 60 === 0) return min === 60 ? "un'ora" : `${min / 60} ore`;
  const h = Math.floor(min / 60);
  return `${h === 1 ? "un'ora" : `${h} ore`} e ${min % 60} minuti`;
}

/** «avvisami», «avvertimi», «ricordamelo»…: inizio della clausola del preavviso. */
const LEAD_TRIGGER =
  /(?:^|[\s,;])(?:e\s+)?(?:avvisami|avvertimi|ricordamel[oa]|ricordami|avvisa(?:mi)?|avverti(?:mi)?|segnalamelo|mi\s+avvisi|mi\s+avverti|mi\s+ricordi|dammi\s+un\s+avviso|mandami\s+un\s+avviso|fammi\s+un\s+promemoria|mettimi\s+un\s+promemoria|promemoria)\s+/iu;
/** «un'ora prima», «30 minuti prima», «mezz'ora prima», «un quarto d'ora prima», «il giorno prima», «prima». */
const REL_LEAD =
  /^(?:(?:(?<n>\d+|un'|una|un|due|tre|quattro|cinque|dieci|quindici|venti|trenta|quarantacinque)\s*(?<u>minut[oi]|or[ae]|giorn[oi]|quart[oi]\s+d'ora))|(?<half>mezz'\s*ora|mezzora|mezz'ora)|(?<day>il\s+giorno)|(?<bare>un\s+po'))?\s*prima\b/iu;
/** «alle 18», «per le 6», «alle 17:30», «alle 6 e mezza di sera». */
const ABS_LEAD =
  /^(?:alle|all'|per\s+le|verso\s+le|entro\s+le)\s*(?:ore\s+)?(?<h>\d{1,2})(?:[:.,](?<mi>\d{2}))?(?:\s+e\s+(?<frac>mezza|mezzo|un\s+quarto|tre\s+quarti))?(?:\s+(?<ap>di\s+mattina|del\s+mattino|di\s+pomeriggio|del\s+pomeriggio|di\s+sera|della\s+sera|di\s+notte))?(?=\s|$)/iu;

/** «ho il dentista» → «il dentista», «devo andare dal medico» → «dal medico». */
function stripEventFillers(t: string): string {
  return t
    .replace(
      /^(?:che\s+)?(?:io\s+)?(?:ho|c'è|c'ho|avrò|avrei|abbiamo|avremo|devo\s+(?:andare|essere|fare|portare)|vado|andrò|sono|ci\s+sarebbe|mi\s+aspetta)\s+/iu,
      '',
    )
    .replace(/\s+(?:e|ed|che)$/iu, '')
    .trim();
}

/**
 * Appuntamento con preavviso (richiesta dell'utente, 15 ott 2026): «ho il dentista alle 19, avvertimi alle 18»,
 * «domani alle 10 ho la riunione, ricordamelo mezz'ora prima», «avvisami un'ora prima che alle 15 c'è la visita».
 * Servono due tempi: quello dell'appuntamento (con l'ora detta) e quello dell'avviso, assoluto o relativo.
 * Un'ora assoluta ambigua («avvisami alle 6» per le 19) è letta come la più vicina all'appuntamento (le 18).
 * Null se non è una frase di questo tipo: ci pensano il parser generale o il modello.
 */
export function parseAppointment(input: string, now: Date, tz: string): ReminderPlan | null {
  const text = ` ${normalizeHourWords(input.replace(/[‘’´`]/gu, "'"))
    .replace(/\s+/g, ' ')
    .trim()} `;
  // Il preavviso può stare dopo un primo «ricordami»: «Ricordami domani di uscire alle 17. Ricordamelo 10 minuti
  // prima», «ricordami alle 18 di chiamare Luca, avvisami 5 minuti prima» (segnalato il 15 ott 2026). Si prova
  // ogni clausola, nell'ordine: vale la prima che dà un appuntamento con il suo preavviso.
  for (const trig of text.matchAll(new RegExp(LEAD_TRIGGER.source, 'giu'))) {
    // Dopo «ricordami» o «promemoria» vale solo un preavviso relativo («10 minuti prima»): «ricordami alle 18 di
    // chiamare Luca e alle 19 di uscire» sono due promemoria, non un appuntamento alle 19 (revisione del 16 ott).
    const relOnly =
      /^(?:e\s+)?(?:ricordami|promemoria|fammi\s+un\s+promemoria|mettimi\s+un\s+promemoria)$/iu.test(
        trig[0].replace(/^[\s,;]+/u, '').trim(),
      );
    const plan = appointmentAt(text, trig.index + trig[0].length, trig.index, now, tz, relOnly);
    if (plan) return plan;
  }
  return null;
}

/** Appuntamento con il preavviso che comincia a `leadStart` (dopo «avvisami»); la clausola inizia a `trigStart`. */
function appointmentAt(
  text: string,
  leadStart: number,
  trigStart: number,
  now: Date,
  tz: string,
  relOnly = false,
): ReminderPlan | null {
  const after = text.slice(leadStart);
  let leadLen = 0;
  let relMs: number | null = null;
  let relAssumed: string | null = null;
  let abs: { hour: number; minute: number; ap: string } | null = null;
  const rel = REL_LEAD.exec(after);
  if (rel?.groups) {
    leadLen = rel[0].length;
    if (rel.groups.half) relMs = 30 * 60_000;
    else if (rel.groups.day) relMs = 24 * 3_600_000;
    else if (rel.groups.u) {
      const n = /^\d+$/.test(rel.groups.n ?? '')
        ? Number(rel.groups.n)
        : (NUM_WORDS[(rel.groups.n ?? '').toLowerCase()] ?? 1);
      const u = rel.groups.u.toLowerCase();
      relMs = u.startsWith('min')
        ? n * 60_000
        : u.startsWith('or')
          ? n * 3_600_000
          : u.startsWith('giorn')
            ? n * 86_400_000
            : n * 15 * 60_000;
    } else {
      relMs = 3_600_000;
      relAssumed = "un'ora di preavviso, perché non hai detto quanto prima";
    }
  } else {
    if (relOnly) return null;
    const a = ABS_LEAD.exec(after);
    if (!a?.groups?.h) return null;
    leadLen = a[0].length;
    let minute = a.groups.mi ? Number(a.groups.mi) : 0;
    const frac = a.groups.frac?.toLowerCase();
    if (frac?.startsWith('mezz')) minute = 30;
    else if (frac === 'un quarto') minute = 15;
    else if (frac === 'tre quarti') minute = 45;
    abs = { hour: Number(a.groups.h), minute, ap: a.groups.ap?.toLowerCase() ?? '' };
    if (abs.hour > 23 || minute > 59) return null;
  }
  const eventPart = `${text.slice(0, trigStart)} ${after.slice(leadLen)}`
    .replace(/[,;.!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Il primo «ricordami (di)» non fa parte dell'appuntamento.
    .replace(/(?:^|\s)(?:ricordami|ricordati|ricorda(?:mi)?)(?=\s|$)\s*(?:di\s)?/iu, ' ')
    .trim()
    .replace(/^(?:che|perché|perche|e|ed|ma|poi|allora)\s+/iu, '')
    .trim();
  if (!eventPart) return null;
  const parsed = parseWhen(eventPart, now, tz);
  if (!parsed || 'needTime' in parsed || !parsed.timeGiven) return null;
  const eventAt = parsed.at;
  const what = stripEventFillers(parsed.text);
  if (!what) return null;
  const assumed = [...parsed.assumed];
  let at: Date;
  if (relMs !== null) {
    at = new Date(eventAt.getTime() - relMs);
    if (relAssumed) assumed.push(relAssumed);
  } else if (abs) {
    // Candidati: l'ora detta e, se ambigua, la stessa ora del pomeriggio; il giorno dell'appuntamento o quello prima.
    let hours = [abs.hour];
    if (/sera|pomeriggio|notte/.test(abs.ap) && abs.hour < 12) hours = [abs.hour + 12];
    else if (/mattin/.test(abs.ap)) hours = [abs.hour === 12 ? 0 : abs.hour];
    else if (abs.hour < 12) hours = [abs.hour, abs.hour + 12];
    const ep = localParts(eventAt, tz);
    const [py, pm, pd] = addDays(ep.year, ep.month, ep.day, -1);
    const candidates = [
      ...hours.map((h) => zonedToUtc(tz, ep.year, ep.month, ep.day, h, abs?.minute ?? 0)),
      ...hours.map((h) => zonedToUtc(tz, py, pm, pd, h, abs?.minute ?? 0)),
    ]
      .filter((t) => t.getTime() < eventAt.getTime() && t.getTime() > now.getTime() + 30_000)
      .sort((x, y) => y.getTime() - x.getTime());
    if (!candidates[0]) return null;
    at = candidates[0];
  } else return null;
  if (at.getTime() <= now.getTime() + 30_000 || at.getTime() >= eventAt.getTime()) return null;
  return { op: 'create', text: what, at, eventAt, assumed };
}

/**
 * Sveglia (richiesta dell'utente, 13 ott 2026): «svegliami domani alle 6», «senti, svegliami per le sei», «metti la
 * sveglia alle 7 e mezza», «ogni giorno svegliami alle 7», «svegliami tra 20 minuti». Diventa un promemoria con la
 * sveglia accesa e l'email spenta (suona sul telefono con Posticipa). Null se non è una richiesta di sveglia.
 */
export function parseWakeUp(text: string, now: Date, tz: string): ReminderPlan | null {
  const trigger =
    /(?:^|\s)(?:svegliami|risvegliami|(?:mi\s+)?(?:mett(?:i|ere|imi)|impost(?:a|i|are|ami)|punt(?:a|i|are|ami)|programm(?:a|i|are|ami))\s+(?:la\s+|una\s+)?sveglia|^sveglia(?=\s+(?:domani|dopodomani|alle|all'|per|tra|fra|ogni|oggi|stamattina|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)))(?=[\s,.;:!?]|$)/iu.exec(
      text,
    );
  if (!trigger) return null;
  let rest = `${text.slice(0, trigger.index)} ${text.slice(trigger.index + trigger[0].length)}`;
  // Parole di contorno del parlato: «senti», «ehi Ernie», «per favore», «mi raccomando».
  rest = ` ${rest.replace(/[,;]|:(?!\d)/g, ' ')} `
    .replace(
      /[\s,;:]+(?:senti|ascolta|ehi|ernie|ok|okay|allora|per\s+favore|grazie|mi\s+raccomando|dai)(?=[\s,;:.!?])/giu,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,;:]+|[,;:]+$/g, '')
    .trim();
  const note = (residue: string) => {
    const r = clean(residue.replace(/^[,;:\s]+|[,;:\s]+$/g, ''))
      .replace(/^(?:perché|che|così)\s+/iu, '')
      .trim();
    return r ? `Sveglia: ${r.charAt(0).toUpperCase()}${r.slice(1)}` : 'Sveglia';
  };
  const normalized = normalizeHourWords(rest);
  // Ricorrente: «ogni giorno», «nei giorni feriali», «ogni lunedì e giovedì».
  const rep = parseRepeat(`${normalized} sveglia`);
  if (rep)
    return {
      op: 'create',
      text: note(rep.text.replace(/\s*sveglia$/iu, '')),
      at: firstOccurrence(rep.repeat, now, tz),
      assumed: rep.assumed,
      repeat: rep.repeat,
      alarm: true,
    };
  const parsed = parseWhen(normalized, now, tz, { morning: true });
  if (parsed === null) return null;
  if ('needTime' in parsed) return { op: 'ask_time', text: note(parsed.needTime), alarm: true };
  return {
    op: 'create',
    text: note(parsed.text),
    at: parsed.at,
    // «Domani, perché oggi quell'ora è già passata» per una sveglia è ovvio: non lo si dice.
    assumed: parsed.assumed.filter((a) => !a.startsWith('domani')),
    alarm: true,
  };
}

/** Email valida in minuscolo (dalla frase dell'utente), altrimenti undefined. */
export function normalizeEmailAddress(v: string | null | undefined): string | undefined {
  const t = (v ?? '')
    .trim()
    .replace(/[.,;:!?»”)]+$/u, '')
    .toLowerCase()
    .replace(/^mailto:/, '');
  return /^[^\s@<>(),;:«“]+@[^\s@<>(),;:]+\.[a-z]{2,}$/.test(t) && t.length <= 120 ? t : undefined;
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
  const a = awaiting as {
    kind?: unknown;
    text?: unknown;
    who?: unknown;
    email?: unknown;
    alarm?: unknown;
  } | null;
  // Risposta a «dov'è casa?»: un indirizzo (via, piazza o numero civico) per quel luogo.
  if (a?.kind === 'place') {
    const label = (awaiting as { label?: unknown }).label;
    const address = addressLike(input);
    return typeof label === 'string' && label && address
      ? { op: 'set_place', label, address }
      : null;
  }
  // Risposta a «qual è la tua email?»: basta che nel messaggio ci sia un indirizzo valido.
  if (a?.kind === 'email') {
    const found = /\S+@\S+/u.exec(input);
    const email = normalizeEmailAddress(found?.[0]);
    return email ? { op: 'set_email', email } : null;
  }
  if (!a || typeof a.text !== 'string' || !a.text.trim()) return null;
  const t = input
    .replace(/[‘’´`]/gu, "'")
    .replace(/[.!?]+$/gu, '')
    .trim();
  if (!t || t.split(/\s+/).length > 8 || /ricorda|promemoria|svegli/iu.test(t)) return null;
  const parsed = parseWhen(t, now, tz, { morning: a.alarm === true });
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
    ...(a.email === true ? { email: true } : {}),
    ...(a.alarm === true ? { alarm: true } : {}),
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
      ...(r.at ? { at: r.at.toISOString() } : {}),
      status: r.status,
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
      ...(r.eventAt ? { eventAt: r.eventAt.toISOString() } : {}),
      ...(r.for ? { for: r.for.slice(0, 60) } : {}),
      ...(r.from ? { from: r.from.slice(0, 60) } : {}),
      ...(r.channels && (r.channels.email !== undefined || r.channels.alarm !== undefined)
        ? { channels: { ...r.channels } }
        : {}),
      ...(r.repeat
        ? {
            repeat: {
              kind: r.repeat.kind,
              hour: r.repeat.hour,
              minute: r.repeat.minute,
              label: repeatLabel(r.repeat),
              ...(r.repeat.weekdays ? { weekdays: [...r.repeat.weekdays] } : {}),
              ...(r.repeat.day ? { day: r.repeat.day } : {}),
            },
          }
        : {}),
    })),
  };
}

/** Il piano a parole, per il controllo di Jev: chi, cosa, quando (con preavviso e ricorrenza). */
export function describeReminderPlan(p: ReminderPlan, tz: string, now = new Date()): string | null {
  const forWho = (who?: string) => (who ? `per ${who}` : 'per l’utente');
  if (p.op === 'create') {
    const kind = p.alarm ? 'sveglia' : 'promemoria';
    const event = p.eventAt
      ? `, preavviso di un appuntamento ${formatWhen(p.eventAt, tz, now)}`
      : '';
    const repeat = p.repeat ? `, ${repeatLabel(p.repeat)}` : '';
    return `${kind} «${p.text}» ${forWho(p.who)} ${formatWhen(p.at, tz, now)}${event}${repeat}`;
  }
  if (p.op === 'create_place')
    return `promemoria «${p.text}» per l’utente quando ${p.place.on === 'leave' ? 'esce da' : 'arriva a'} «${p.place.label}»`;
  return null;
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
      'Promemoria a giorno e ora: «ricordami di … alle 17», «domani alle 9», «tra 20 minuti»; legati a un luogo della scheda («quando arrivo a casa», «quando esco dal lavoro»); appuntamenti con preavviso («ho il dentista alle 19, avvisami alle 18» o «un’ora prima»); sveglie («svegliami domani alle 6», suonano sul telefono); anche a una persona collegata («ricorda a Giorgio di …»); elenco e annullamento.',
    examples: [
      'ricordami di uscire alle 17',
      'ricordami domani alle 9 di chiamare il dentista',
      'tra 20 minuti ricordami di spegnere il forno',
      'ho il dentista alle 19, avvisami alle 18',
      'svegliami domani alle 6',
      'ricordami di comprare il pane quando arrivo a casa',
      'casa mia è in via Roma 3, Treviso',
      'ricorda a Giorgio di chiamarmi domani alle 17',
      'che promemoria ho?',
    ],
    match: (text) => parseReminderCommand(text, new Date(), timezone),
    followUp: (awaiting, text) => reminderFollowUp(awaiting, text, new Date(), timezone),
    describe: (plan) => describeReminderPlan(plan as ReminderPlan, timezone),
    run: async (plan, ctx): Promise<SkillReply> => {
      const p = plan as ReminderPlan;
      switch (p.op) {
        case 'fire': {
          const lead = p.lead ? `${p.lead.charAt(0).toUpperCase()}${p.lead.slice(1)}` : null;
          return {
            text: p.from
              ? `⏰ Promemoria da ${p.from}${p.lead ? `, ${p.lead}` : ''}: ${p.text}`
              : lead
                ? `⏰ ${lead}: ${p.text}`
                : `⏰ Promemoria: ${p.text}`,
            actions: ['fire'],
          };
        }
        case 'ask_time':
          return {
            text: p.alarm
              ? 'A che ora ti sveglio? Dimmi per esempio «alle 6», «domani alle 7 e mezza» o «tra 20 minuti».'
              : `A che ora ${p.who ? `lo ricordo a ${p.who}` : 'te lo ricordo'}? Il promemoria è «${tidyReminderText(p.text)}». Dimmi per esempio «alle 17», «domani alle 9» o «tra 30 minuti».`,
            actions: [],
            // Il messaggio successivo («alle 9») completa questo promemoria.
            awaiting: {
              kind: 'time',
              text: p.text,
              ...(p.who ? { who: p.who } : {}),
              ...(p.email ? { email: true } : {}),
              ...(p.alarm ? { alarm: true } : {}),
            },
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
              ...(p.repeat ? { repeat: p.repeat } : {}),
              ...(p.eventAt ? { eventAt: p.eventAt } : {}),
              // Sveglia: suona sul telefono e niente email, anche se le email dei promemoria sono accese.
              ...(p.alarm
                ? { channels: { alarm: true, email: false }, literalTitle: true }
                : p.email
                  ? { channels: { email: true } }
                  : {}),
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
          const at = r.at ?? p.at;
          let reply: SkillReply;
          if (p.eventAt) {
            const lead = leadQuantity(p.eventAt.getTime() - at.getTime());
            return {
              text: `⏰ Va bene: ${r.text}. Ti avviso ${formatWhen(at, timezone)}, ${lead} prima.${note}`,
              actions: [`create:${r.id}`],
              blocks: [toRemindersBlock([r], 'Appuntamento')],
            };
          }
          if (p.alarm) {
            const why = r.text.startsWith('Sveglia: ') ? ` (${lowerFirst(r.text.slice(9))})` : '';
            const when = r.repeat
              ? `${repeatLabel(r.repeat)}, la prima volta ${formatWhen(at, timezone)}`
              : formatWhen(at, timezone);
            return {
              text: `⏰ Sveglia ${when}${why}.${note} Suona sul telefono come una sveglia, con Posticipa; niente email.`,
              actions: [`create:${r.id}`],
              blocks: [toRemindersBlock([r], 'Sveglia')],
            };
          }
          if (r.repeat) {
            const label = repeatLabel(r.repeat);
            const first = `La prima volta ${formatWhen(at, timezone)}.`;
            reply = r.for
              ? {
                  text: `🔁 Va bene: ${label} ricordo a ${r.for} di ${what}. ${first}${note} Arriva sul suo telefono.`,
                  actions: [`create:${r.id}`],
                  blocks: [toRemindersBlock([r], `Promemoria per ${r.for}`)],
                }
              : {
                  text: `🔁 Va bene: ${label} ti ricordo di ${what}. ${first}${note}`,
                  actions: [`create:${r.id}`],
                  blocks: [toRemindersBlock([r], 'Promemoria')],
                };
          } else if (r.for)
            reply = {
              text: `⏰ Va bene: ricordo a ${r.for} di ${what} ${formatWhen(at, timezone)}.${note} Il promemoria arriva sul suo telefono.`,
              actions: [`create:${r.id}`],
              blocks: [toRemindersBlock([r], `Promemoria per ${r.for}`)],
            };
          else
            reply = {
              text: `⏰ Va bene: ti ricordo di ${what} ${formatWhen(at, timezone)}.${note}`,
              actions: [`create:${r.id}`],
              blocks: [toRemindersBlock([r], 'Promemoria')],
            };
          // Email chiesta ma indirizzo assente: lo chiedo e la risposta lo salva nella scheda.
          if (p.email && store.emailAddress && !(await store.emailAddress(ctx.userId)))
            return {
              ...reply,
              text: `${reply.text}\n\nPer mandartelo anche per email mi serve il tuo indirizzo: qual è? Lo salvo nella tua scheda.`,
              awaiting: { kind: 'email' },
            };
          return reply;
        }
        case 'create_place': {
          if (!store)
            return { text: 'I promemoria non sono disponibili in questo contesto.', actions: [] };
          // «Allo studio di Giulia»: il nome lungo vale se è un luogo della scheda; altrimenti quello breve.
          const longKnown =
            p.alt && store.findPlace ? await store.findPlace(ctx.userId, p.alt.label) : null;
          const q =
            longKnown && p.alt
              ? { text: p.alt.text, place: { ...p.place, label: p.alt.label } }
              : { text: p.text, place: p.place };
          const known =
            longKnown ??
            (store.findPlace ? await store.findPlace(ctx.userId, q.place.label) : undefined);
          const r = await store.create(ctx.userId, { text: q.text, timezone, place: q.place });
          const phrase = placePhrase(q.place);
          const base = `📍 Va bene: ${phrase} ti ricordo di ${lowerFirst(r.text)}.`;
          const blocks = [toRemindersBlock([r], 'Promemoria')];
          if (known === null)
            return {
              text: `${base} Però non so ancora dov'è «${q.place.label}»: dimmi l'indirizzo (per esempio «via Roma 3, Treviso»), di' «salva questo posto come ${q.place.label}» quando ci sei, oppure segnalo sulla mappa in Impostazioni › La tua scheda › Luoghi.`,
              actions: [`create:${r.id}`],
              blocks,
              // Il messaggio successivo («via Roma 3, Treviso») diventa l'indirizzo del luogo.
              awaiting: { kind: 'place', label: q.place.label },
            };
          const brain = known?.fromNote
            ? ` Ho preso «${q.place.label}» dal tuo second brain (nota «${known.fromNote}»${known.address ? `, ${known.address}` : ''}).`
            : '';
          const where =
            known && !known.located && known.address
              ? `${brain} Il telefono cerca da solo la posizione${brain ? '' : ` di «${known.address}»`}: puoi controllarla in Impostazioni › La tua scheda › Luoghi.`
              : `${brain} Scatta sul telefono anche con l’app chiusa.`;
          return { text: `${base}${where}`, actions: [`create:${r.id}`], blocks };
        }
        case 'place_other':
          return {
            text: `Per ora i promemoria legati a un luogo valgono solo per te${p.who ? `, non per ${p.who}` : ''}: dimmi per esempio «ricordami di comprare il pane quando arrivo a casa». A ${p.who ?? 'un familiare'} posso mettere un promemoria a un’ora precisa.`,
            actions: [],
          };
        case 'name_here': {
          if (!store?.setPlaceHere)
            return { text: 'Non posso salvare i luoghi in questo contesto.', actions: [] };
          const loc = ctx.device?.location;
          if (!loc)
            return {
              text: `Non so dove sei adesso: per salvare questo posto come «${p.label}» serve il permesso di posizione per Ernie (Impostazioni › Ernie › Posizione). In alternativa dimmi l'indirizzo, per esempio «${p.label} è in via Roma 3, Treviso».`,
              actions: [],
            };
          const saved = await store.setPlaceHere(ctx.userId, {
            label: p.label,
            lat: loc.latitude,
            lng: loc.longitude,
            ...(loc.accuracyM !== undefined ? { accuracyM: loc.accuracyM } : {}),
          });
          if (!saved)
            return {
              text: 'Non sono riuscito a salvare il luogo (ne hai già dieci?). Puoi gestirli in Impostazioni › La tua scheda › Luoghi.',
              actions: [],
            };
          const precision =
            loc.accuracyM !== undefined
              ? ` (precisione circa ${Math.max(5, Math.round(loc.accuracyM / 5) * 5)} m)`
              : '';
          const pending = (await store.list(ctx.userId)).filter(
            (r) => r.place?.label === saved.label,
          );
          const arrive = placePhrase({ label: saved.label, on: 'arrive' }).replace(
            /^quando arrivi /u,
            '',
          );
          const tail = pending.length
            ? ` ${pending.length === 1 ? `Il promemoria «${pending[0]?.text}» scatterà` : `I ${pending.length} promemoria legati a «${saved.label}» scatteranno`} quando arrivi qui.`
            : ` Ora puoi dire «ricordami di … quando arrivo ${arrive}».`;
          return {
            text: `📍 Fatto: ${saved.moved ? `ho spostato «${saved.label}» qui` : `ho chiamato «${saved.label}» il posto dove sei adesso`}${loc.place ? `, a ${loc.place}` : ''}${precision}.${tail} Puoi aggiustare il punto in Impostazioni › La tua scheda › Luoghi.`,
            actions: ['set_place'],
            ...(pending.length ? { blocks: [toRemindersBlock(pending, 'Promemoria')] } : {}),
          };
        }
        case 'rename_place': {
          if (!store?.renamePlace)
            return { text: 'Non posso rinominare i luoghi in questo contesto.', actions: [] };
          const res = await store.renamePlace(ctx.userId, p.from, p.to);
          if (!res.ok)
            return {
              text:
                res.reason === 'missing'
                  ? `Non trovo un luogo chiamato «${p.from}» nella tua scheda. Puoi vederli in Impostazioni › La tua scheda › Luoghi.`
                  : res.reason === 'taken'
                    ? `C'è già un luogo chiamato «${p.to}»: scegli un altro nome o toglilo da Impostazioni › La tua scheda › Luoghi.`
                    : 'Il nome nuovo non va bene: provane un altro.',
              actions: [],
            };
          // Le schede già in chat si aggiornano con il nome nuovo (stessi promemoria, stesso id).
          const moved = res.reminders
            ? (await store.list(ctx.userId)).filter((r) => r.place?.label === res.to)
            : [];
          return {
            text: `📍 Fatto: «${res.from}» ora si chiama «${res.to}».${res.reminders ? ` Ho aggiornato anche ${res.reminders === 1 ? 'il promemoria legato' : `i ${res.reminders} promemoria legati`} a quel luogo.` : ''}`,
            actions: ['rename_place'],
            ...(moved.length ? { blocks: [toRemindersBlock(moved, 'Promemoria')] } : {}),
          };
        }
        case 'set_place': {
          if (!store?.setPlace)
            return { text: 'Non posso salvare i luoghi in questo contesto.', actions: [] };
          const saved = await store.setPlace(ctx.userId, { label: p.label, address: p.address });
          if (!saved)
            return {
              text: 'Non sono riuscito a salvare il luogo (ne hai già dieci?). Puoi gestirli in Impostazioni › La tua scheda › Luoghi.',
              actions: [],
            };
          const pending = (await store.list(ctx.userId)).filter(
            (r) => r.place?.label === saved.label,
          );
          const tail = pending.length
            ? ` ${pending.length === 1 ? `Il promemoria «${pending[0]?.text}» scatterà` : `I ${pending.length} promemoria legati a «${saved.label}» scatteranno`} quando arrivi lì.`
            : '';
          return {
            text: `📍 Fatto: «${saved.label}» è in ${saved.address}.${tail} Il telefono trova la posizione da solo; puoi controllarla sulla mappa in Impostazioni › La tua scheda › Luoghi.`,
            actions: ['set_place'],
            ...(pending.length ? { blocks: [toRemindersBlock(pending, 'Promemoria')] } : {}),
          };
        }
        case 'set_email': {
          if (!store?.setEmail)
            return { text: 'Non posso salvare l’email in questo contesto.', actions: [] };
          const before = (await store.emailAddress?.(ctx.userId)) ?? null;
          const ok = await store.setEmail(ctx.userId, p.email);
          if (!ok) return { text: 'Non sono riuscito a salvare l’email, riprova.', actions: [] };
          return {
            text:
              before && before !== p.email
                ? `✉️ Fatto: ho sostituito ${before} con ${p.email} nella tua scheda. Le email dei promemoria arriveranno lì.`
                : `✉️ Fatto: ho salvato ${p.email} nella tua scheda. Le email dei promemoria arriveranno lì.`,
            actions: ['set_email'],
          };
        }
        case 'list': {
          if (!store)
            return { text: 'I promemoria non sono disponibili in questo contesto.', actions: [] };
          const list = await store.list(ctx.userId);
          if (!list.length) return { text: 'Non hai promemoria in programma.', actions: ['list'] };
          return {
            // Una riga per promemoria, senza parentesi annidate; i ricorrenti dicono la loro ripetizione.
            text: `Hai ${list.length} promemoria:\n${list
              .map((r) => {
                const who = r.for ? `, per ${r.for}` : r.from ? `, da ${r.from}` : '';
                if (r.place || !r.at)
                  return `- ${r.text}${who}: ${r.place ? placePhrase(r.place) : 'senza ora'}`;
                const when = r.repeat
                  ? `${repeatLabel(r.repeat)}, la prossima ${formatWhen(r.at, timezone)}`
                  : formatWhen(r.at, timezone);
                return `- ${r.text}${who}: ${when}`;
              })
              .join('\n')}`,
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
                if (!r.at) return false;
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
