import type { JevClient } from './client.js';
import type { JevQuestion } from './schema.js';

/**
 * Chiarimento interno (richiesta dell'utente, 15 ott 2026): quando un messaggio è poco chiaro, o l'utente corregge
 * Ernie, un modello leggero scrive domande chiuse sul testo («“lui” è Giorgio o Fabio?», «“Jeff” è Jev?») e Jev
 * sceglie la risposta con una confidenza, dal contesto. Le risposte sicure diventano una nota per il modello che
 * risponde; i dubbi restano dubbi (il modello può chiedere all'utente con una domanda a pulsanti).
 */
export type ClarifyTrigger = 'ambiguous' | 'correction';

export interface ClarifyQuestion {
  /** Il pezzo di testo in dubbio, come l'ha scritto l'utente («lui», «Jeff», «venerdì»). */
  readonly about: string;
  readonly question: string;
  /** Da 2 a 4 interpretazioni possibili, prese dal contesto. */
  readonly options: readonly string[];
}

export interface ClarifyInput {
  readonly trigger: ClarifyTrigger;
  readonly message: string;
  readonly inputMode: 'text' | 'voice';
  /** Ultimi scambi già compressi («utente: …», «assistente: …»). */
  readonly recentTurns: readonly string[];
  /** Persone collegate e nomi noti (etichette di Famiglia, nome dell'utente). */
  readonly people: readonly string[];
  /** Luoghi della scheda («casa», «lavoro», «palestra»). */
  readonly places: readonly string[];
}

export type Questioner = (
  input: ClarifyInput,
) => Promise<{ questions: readonly ClarifyQuestion[]; costUsd: number }>;

export interface ClarifyAnswer {
  readonly about: string;
  readonly question: string;
  /** L'opzione scelta da Jev, o null se ha scelto «non si può dire». */
  readonly meaning: string | null;
  readonly confidence: number;
}

export interface Clarification {
  readonly trigger: ClarifyTrigger;
  readonly questions: readonly ClarifyQuestion[];
  readonly answers: readonly ClarifyAnswer[];
  /** Risposte sopra la soglia: entrano nella nota per il modello e nella riga in chat. */
  readonly resolved: readonly { about: string; meaning: string; confidence: number }[];
  /** Domande rimaste aperte (Jev incerto o «non si può dire»). */
  readonly unresolved: readonly ClarifyQuestion[];
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface ClarifierOptions {
  readonly jev: JevClient | null;
  readonly questioner: Questioner;
  readonly model?: string;
  /** Confidenza minima di Jev perché una risposta conti. */
  readonly minConfidence: number;
  /** Tempo massimo complessivo (domande + risposte): oltre, si risponde senza chiarimento. */
  readonly timeoutMs?: number;
}

export interface Clarifier {
  clarify(input: ClarifyInput): Promise<Clarification | null>;
}

const UNKNOWN = 'non_si_sa';
const MAX_QUESTIONS = 4;

/** Domande chiuse per Jev: una `choice` per domanda, con «non si può dire» sempre fra le opzioni. */
export function clarifyQuestions(
  questions: readonly ClarifyQuestion[],
): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  questions.slice(0, MAX_QUESTIONS).forEach((q, i) => {
    out[`q${i + 1}`] = {
      type: 'choice',
      instructions: `${q.question} (nel messaggio: «${q.about}»)`,
      criteria: {
        ...Object.fromEntries(q.options.slice(0, 4).map((o, j) => [`o${j + 1}`, o])),
        [UNKNOWN]: 'Dal messaggio e dal contesto non si può stabilire.',
      },
    };
  });
  return out;
}

export function clarifyState(input: ClarifyInput): Record<string, unknown> {
  return {
    user_message: input.message.slice(0, 2000),
    input_mode: input.inputMode,
    // A voce la trascrizione può sbagliare le parole: Jev ne tiene conto per i nomi strani.
    ...(input.inputMode === 'voice'
      ? { note: 'Messaggio dettato: la trascrizione può aver storpiato nomi e parole.' }
      : {}),
    situation:
      input.trigger === 'correction'
        ? 'L’utente sta correggendo la risposta precedente dell’assistente: le domande riguardano cosa intendeva davvero.'
        : 'Il messaggio sembra poco chiaro: le domande riguardano cosa intende l’utente.',
    recent_turns: input.recentTurns.slice(-6),
    known_people: input.people.slice(0, 12),
    known_places: input.places.slice(0, 10),
  };
}

const sane = (q: ClarifyQuestion): boolean =>
  q.about.trim().length > 0 &&
  q.question.trim().length > 0 &&
  new Set(q.options.map((o) => o.trim().toLowerCase()).filter(Boolean)).size >= 2;

export function createClarifier(opts: ClarifierOptions): Clarifier {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return {
    async clarify(input) {
      if (!opts.jev) return null;
      const t0 = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const deadline = new Promise<never>((_, reject) =>
          ac.signal.addEventListener('abort', () =>
            reject(new Error('chiarimento: tempo scaduto')),
          ),
        );
        // Se scade mentre risponde Jev, l'errore arriva dalla sua richiesta: questa non deve restare non gestita.
        deadline.catch(() => {});
        const asked = await Promise.race([opts.questioner(input), deadline]);
        const questions = asked.questions.filter(sane).slice(0, MAX_QUESTIONS);
        if (!questions.length) return null;
        const res = await opts.jev.decide(
          {
            ...(opts.model ? { model: opts.model } : {}),
            state: clarifyState(input),
            questions: clarifyQuestions(questions),
          },
          { signal: ac.signal },
        );
        const answers: ClarifyAnswer[] = questions.map((q, i) => {
          const a = res.answers[`q${i + 1}`];
          if (a?.type !== 'choice')
            return { about: q.about, question: q.question, meaning: null, confidence: 0 };
          const idx = /^o(\d)$/.exec(a.choice)?.[1];
          const meaning = idx ? (q.options[Number(idx) - 1] ?? null) : null;
          return { about: q.about, question: q.question, meaning, confidence: a.confidence ?? 0 };
        });
        const resolved = answers
          .filter(
            (a): a is ClarifyAnswer & { meaning: string } =>
              a.meaning !== null && a.confidence >= opts.minConfidence,
          )
          .map((a) => ({ about: a.about, meaning: a.meaning, confidence: a.confidence }));
        const unresolved = questions.filter((_, i) => {
          const a = answers[i];
          return !a || a.meaning === null || a.confidence < opts.minConfidence;
        });
        return {
          trigger: input.trigger,
          questions,
          answers,
          resolved,
          unresolved,
          costUsd: asked.costUsd + (res.usage?.cost ?? 0),
          latencyMs: Date.now() - t0,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Nota per il modello che risponde (contesto del turno, non salvata). Le interpretazioni sono probabili, non
 * certe: se l'utente le smentisce, vale l'utente.
 */
export function clarificationNote(c: Clarification): string | null {
  const lines: string[] = [];
  if (c.trigger === 'correction')
    lines.push(
      'L’utente sta correggendo la tua risposta precedente: rileggi la sua richiesta alla luce della correzione e non ripetere lo stesso errore.',
    );
  if (c.resolved.length)
    lines.push(
      `Chiarimento interno sul messaggio (interpretazioni probabili dal contesto): ${c.resolved
        .map((r) => `«${r.about}» = ${r.meaning}`)
        .join('; ')}.`,
    );
  if (c.unresolved.length)
    lines.push(
      `Dubbi rimasti: ${c.unresolved
        .map((q) => `${q.question} (${q.options.join(' / ')})`)
        .join(
          '; ',
        )}. Se senza saperlo rischi di sbagliare, chiedi all’utente con UNA domanda chiusa (present_choices); altrimenti rispondi.`,
    );
  return lines.length ? lines.join('\n') : null;
}

/**
 * Controllo dei comandi rapidi (richiesta dell'utente, 15 ott 2026: «Jev deve aiutare l'utente che non formula i
 * messaggi nella maniera più corretta»). Prima di eseguire senza modello un comando riconosciuto da una skill
 * (promemoria, messaggio), Jev confronta quello che la skill ha capito con la frase: se ne ignora o travisa una
 * parte, la richiesta passa al modello con gli strumenti. Esempio reale: «Ricordami domani di uscire alle 17 per
 * il treno. Ricordamelo 10 minuti prima» era diventato «Prendere il treno, domani alle 17».
 */
export interface SkillCheckInput {
  readonly message: string;
  /** Cosa farà la skill, in italiano semplice («promemoria “Prendere il treno” domani alle 17:00»). */
  readonly planned: string;
  readonly inputMode: 'text' | 'voice';
  readonly recentTurns: readonly string[];
  /** Ora locale dell'utente («giovedì 15 ottobre 2026, 23:32»): serve a verificare «tra 20 minuti», «domani». */
  readonly nowLocal?: string;
}

export interface SkillCheckResult {
  /** P(il comando fa esattamente quello che chiede l'utente). */
  readonly faithful: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export function skillCheckQuestions(): Record<string, JevQuestion> {
  return {
    faithful: {
      type: 'noul',
      instructions:
        'Il comando che sta per essere eseguito (planned_action) fa esattamente quello che chiede il messaggio dell’utente?',
      criteria: {
        true: 'Sì: stessa azione, stessa persona, stesso orario o luogo, e nessuna parte della richiesta è ignorata.',
        false:
          'No: ignora o travisa una parte della richiesta (un preavviso, un secondo orario, la persona, un secondo compito, una condizione) oppure fa un’azione diversa.',
      },
    },
  };
}

export function createSkillCheck(opts: {
  readonly jev: JevClient | null;
  readonly model?: string;
  readonly timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 1_800;
  return {
    async check(input: SkillCheckInput): Promise<SkillCheckResult | null> {
      if (!opts.jev) return null;
      const t0 = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await opts.jev.decide(
          {
            ...(opts.model ? { model: opts.model } : {}),
            state: {
              user_message: input.message.slice(0, 2000),
              input_mode: input.inputMode,
              planned_action: input.planned.slice(0, 400),
              ...(input.nowLocal ? { now: input.nowLocal } : {}),
              recent_turns: input.recentTurns.slice(-4),
            },
            questions: skillCheckQuestions(),
          },
          { signal: ac.signal },
        );
        const a = res.answers.faithful;
        if (a?.type !== 'noul') return null;
        return { faithful: a.noul, costUsd: res.usage?.cost ?? 0, latencyMs: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export type SkillCheck = ReturnType<typeof createSkillCheck>;
