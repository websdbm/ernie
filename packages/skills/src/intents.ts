import { UnknownPersonError } from './reminder.js';
import type { DeterministicSkill, SkillReply } from './types.js';

/**
 * Promemoria a evento (ricerca 11, S1; idea da OpenClaw «standing intents»): «quando si parla della gita,
 * ricordami il modulo». Non c'è un'ora: scatta quando nei messaggi dell'utente compaiono le parole chiave
 * (full-text italiano, senza modello). Freni: 24 ore tra due attivazioni, al massimo 3, scadenza 90 giorni.
 * Per un familiare: «quando Giorgio parla della gita, ricordagli il modulo» (scatta nei messaggi di Giorgio).
 */
export interface StandingIntent {
  readonly id: string;
  readonly trigger: string;
  readonly reminder: string;
  readonly fires: number;
  readonly expiresAt: Date;
  readonly from?: string;
  readonly for?: string;
}

export interface IntentStore {
  create(
    userId: string,
    i: { trigger: string; reminder: string; forLabel?: string },
  ): Promise<StandingIntent>;
  list(userId: string): Promise<StandingIntent[]>;
  cancel(userId: string, what: string): Promise<StandingIntent | null>;
  /** Attivazioni per un messaggio dell'utente (aggiorna contatori e stato in modo atomico). */
  fire(userId: string, text: string): Promise<StandingIntent[]>;
}

export type IntentPlan =
  | { op: 'create'; trigger: string; reminder: string; who?: string }
  | { op: 'list' }
  | { op: 'cancel'; what: string };

const TALK =
  '(?:si\\s+parla|parliamo|parlo|ti\\s+parlo|nomino|menziono|esce\\s+(?:fuori\\s+)?|salta\\s+fuori|viene\\s+fuori)';
// Alternative dalla più lunga: «della» non deve diventare «del» + «la gita».
const ART =
  "(?:(?:della|dello|delle|degli|dell['’]|dei|del|di|de\\s+la|gli|il|lo|la|le|l['’]|i)\\s*)?";

const CREATE: readonly RegExp[] = [
  // quando si parla della gita, ricordami (di) portare il modulo
  new RegExp(
    `^(?:ernie[,\\s]+)?(?:quando|se|ogni\\s+volta\\s+che)\\s+${TALK}\\s+${ART}(?<trigger>.+?)\\s*,?\\s+ricordami\\s+(?:di\\s+|che\\s+)?(?<reminder>.+?)[.!]?$`,
    'iu',
  ),
  // ricordami (di) portare il modulo quando si parla della gita
  new RegExp(
    `^(?:ernie[,\\s]+)?ricordami\\s+(?:di\\s+|che\\s+)?(?<reminder>.+?)\\s+(?:quando|se|ogni\\s+volta\\s+che)\\s+${TALK}\\s+${ART}(?<trigger>.+?)[.!?]?$`,
    'iu',
  ),
  // quando Giorgio parla della gita, ricordagli (di) portare il modulo
  new RegExp(
    `^(?:ernie[,\\s]+)?(?:quando|se|ogni\\s+volta\\s+che)\\s+(?<who>\\p{Lu}\\p{L}+)\\s+(?:parla|nomina|menziona)\\s+${ART}(?<trigger>.+?)\\s*,?\\s+(?:ricordagli|ricordale|ricordaglielo)\\s+(?:di\\s+|che\\s+)?(?<reminder>.+?)[.!]?$`,
    'u',
  ),
];
const LIST =
  /^(?:che|quali)\s+promemoria\s+(?:a\s+evento|legati\s+(?:agli\s+argomenti|a\s+un\s+argomento)|a\s+tema)\s+(?:ho|ci\s+sono)\s*\??$/iu;
// «A evento» obbligatorio con «di/del»: «cancella il promemoria del dentista» è di Ricordami (revisione del
// 16 ott 2026); «su/sul…» resta di questa skill anche senza.
const CANCEL =
  /^(?:annulla|togli|cancella)\s+(?:il\s+)?promemoria\s+(?:a\s+evento\s+(?:su|sul|sulla|sullo|sui|sugli|sulle|di|del|della)|su|sul|sulla|sullo|sui|sugli|sulle)\s+(?<what>.+?)[.!]?$/iu;

export function parseIntentCommand(text: string): IntentPlan | null {
  const t = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[‘’´`]/gu, "'");
  if (LIST.test(t)) return { op: 'list' };
  const c = CANCEL.exec(t);
  if (c?.groups?.what) return { op: 'cancel', what: c.groups.what };
  for (const re of CREATE) {
    const m = re.exec(t);
    const trigger = m?.groups?.trigger?.trim();
    const reminder = m?.groups?.reminder?.trim();
    if (trigger && reminder && trigger.length >= 3 && reminder.length >= 3)
      return { op: 'create', trigger, reminder, ...(m?.groups?.who ? { who: m.groups.who } : {}) };
  }
  return null;
}

/** Testo per il contesto del modello (o da aggiungere a una risposta locale) quando un promemoria scatta. */
export function formatFiredIntents(fired: readonly StandingIntent[]): string {
  if (!fired.length) return '';
  return fired
    .map(
      (f) =>
        `📌 ${f.from ? `Promemoria da ${f.from}` : 'Ti ricordo'} (hai parlato di «${f.trigger}»): ${f.reminder}`,
    )
    .join('\n');
}

const fmtDay = (d: Date) =>
  new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long' }).format(d);
/** «fino al 12 gennaio», ma «fino all'8» e «fino all'11» (elisione). */
const until = (d: Date) => {
  const day = Number(new Intl.DateTimeFormat('it-IT', { day: 'numeric' }).format(d));
  return `${day === 8 || day === 11 ? 'all’' : 'al '}${fmtDay(d)}`;
};

export function createIntentSkill(store: IntentStore | null): DeterministicSkill {
  return {
    id: 'promemoria_evento',
    kind: 'deterministic',
    category: 'reminders',
    description:
      'Promemoria legati a un argomento: «quando si parla della gita, ricordami il modulo»; anche per un familiare collegato. Scattano quando l’argomento compare nei messaggi, senza modello.',
    examples: ['quando si parla della gita, ricordami il modulo', 'che promemoria a evento ho?'],
    match: (text) => parseIntentCommand(text),
    async run(plan, ctx): Promise<SkillReply> {
      const p = plan as IntentPlan;
      if (!store) return { text: 'I promemoria a evento non sono disponibili qui.', actions: [] };
      if (p.op === 'list') {
        const all = await store.list(ctx.userId);
        if (!all.length) return { text: 'Non hai promemoria a evento attivi.', actions: [] };
        return {
          text: `Promemoria a evento attivi:\n${all
            .map(
              (i) =>
                `- quando ${i.for ? `${i.for} parla` : 'si parla'} di «${i.trigger}»: ${i.reminder}${i.from ? ` (da ${i.from})` : ''} · fino ${until(i.expiresAt)}`,
            )
            .join('\n')}`,
          actions: ['intents:list'],
        };
      }
      if (p.op === 'cancel') {
        const done = await store.cancel(ctx.userId, p.what);
        return done
          ? {
              text: `Fatto: non ti ricordo più «${done.reminder}» quando si parla di «${done.trigger}».`,
              actions: [`intents:cancel:${done.id}`],
            }
          : { text: `Non trovo un promemoria a evento su «${p.what}».`, actions: [] };
      }
      try {
        const i = await store.create(ctx.userId, {
          trigger: p.trigger,
          reminder: p.reminder,
          ...(p.who ? { forLabel: p.who } : {}),
        });
        const who = i.for ? `quando ${i.for} parlerà` : 'quando si parlerà';
        return {
          text: `📌 Va bene: ${who} di «${i.trigger}» ${i.for ? 'gli ricorderò' : 'ti ricorderò'}: ${i.reminder}. Vale fino ${until(i.expiresAt)}, al massimo tre volte e non più di una al giorno.`,
          actions: [`intents:create:${i.id}`],
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'GenericTriggerError')
          return {
            text: `«${p.trigger}» è troppo generico per riconoscerlo nei messaggi: dimmi una parola più precisa (per esempio «gita a Ravenna»).`,
            actions: [],
          };
        if (err instanceof UnknownPersonError)
          return {
            text: `Non conosco nessun «${err.label}». Collega la sua installazione da Impostazioni → Famiglia e riprova.`,
            actions: [],
          };
        throw err;
      }
    },
  };
}
