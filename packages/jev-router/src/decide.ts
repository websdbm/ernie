import type { Logger } from '@ernie/observability';
import { type DecisionCache, decisionCacheKey } from './cache.js';
import type { JevClient } from './client.js';
import {
  DEFAULT_THRESHOLDS,
  type JevQuestion,
  type JevResponse,
  type RouteDecision,
  type Thresholds,
} from './schema.js';

export interface RouterInput {
  readonly text: string;
  readonly inputMode: 'text' | 'voice';
  /** Ultimi scambi, già compressi (max ~6 righe): entrano nello `state`. */
  readonly recentTurns: readonly string[];
  /** Categorie di tool attive per l'utente/sessione (vuoto in M3). */
  readonly toolCategories: readonly string[];
  /** Skill candidate dal retrieval deterministico (vuoto in M3). */
  readonly skillCandidates: readonly string[];
  /** Classe corrente della sessione: dentro il turno la decisione non scende sotto questa. */
  readonly sessionModelClass: 'light' | 'standard' | 'heavy';
  /** Impronta del contesto per la chiave di cache (categorie, skill, classe). */
  readonly contextFingerprint?: string;
}

export interface RouterOptions {
  readonly client: JevClient | null;
  readonly cache?: DecisionCache;
  readonly thresholds?: Thresholds;
  readonly timeoutMs?: number;
  readonly cacheTtlSeconds?: number;
  readonly logger?: Pick<Logger, 'warn' | 'debug'>;
  readonly model?: string;
}

const CLASS_RANK = { light: 0, standard: 1, heavy: 2 } as const;

/**
 * Le sette domande (03-revisione §6) più due per il chiarimento interno (ambiguità e correzione).
 * `tool_category` e `skill_candidate` solo se ci sono opzioni.
 */
export function buildQuestions(input: RouterInput): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {
    route: {
      type: 'choice',
      instructions: 'Come va gestita la richiesta?',
      criteria: {
        deterministic:
          'Convenevoli, ringraziamenti, conferme o comandi semplici che non richiedono di generare testo nuovo.',
        skill:
          'Una procedura nota del registro delle skill può eseguirla senza un modello linguistico.',
        llm: 'Serve generare una risposta o ragionare con un modello linguistico.',
      },
    },
    model_class: {
      type: 'choice',
      instructions: 'Quale classe di modello serve per rispondere bene?',
      criteria: {
        standard: 'Conversazione ordinaria, domande dirette, uso semplice di strumenti.',
        heavy:
          'Pianificazione in più passi, analisi complessa, confronto di alternative, ragionamento esteso.',
      },
    },
    deep_reasoning: {
      type: 'noul',
      instructions: 'La richiesta richiede pianificazione o analisi in più passi?',
      criteria: {
        true: 'Serve ragionare in più passi, pianificare o confrontare alternative.',
        false: 'Risposta diretta o compito semplice.',
      },
    },
    needs_memory: {
      type: 'noul',
      instructions:
        "La risposta dipende da fatti personali, preferenze o dalla storia dell'utente?",
      criteria: {
        true: "Servono preferenze, abitudini, fatti o cronologia dell'utente.",
        false: 'Non servono informazioni personali.',
      },
    },
    risk: {
      type: 'noul',
      instructions: 'La richiesta implica azioni con effetti esterni o dati sensibili?',
      criteria: {
        true: 'Modifica dati, invia messaggi, spende denaro, tocca salute, finanze o persone terze.',
        false: 'Sola lettura, conversazione o informazione generale.',
      },
    },
    ambiguous: {
      type: 'noul',
      instructions:
        'Considerando gli ultimi scambi, il messaggio si può intendere in modi diversi o contiene parti poco chiare?',
      criteria: {
        true: 'Pronomi o riferimenti senza un referente certo, nomi o parole che sembrano errori di dettatura, date o luoghi che possono indicare cose diverse, una richiesta con due letture.',
        false: 'Si capisce con sicurezza cosa vuole l’utente, anche grazie agli ultimi scambi.',
      },
    },
    correction: {
      type: 'noul',
      instructions: 'L’utente sta correggendo un fraintendimento della risposta precedente?',
      criteria: {
        true: 'Dice che la risposta non era quella giusta, che intendeva altro, che non è stato capito, o ripete la richiesta precisandola.',
        false: 'Nuova richiesta, continuazione o conferma della conversazione.',
      },
    },
  };
  if (input.toolCategories.length > 0) {
    q.tool_category = {
      type: 'choice',
      instructions: 'Quale categoria di strumenti serve?',
      criteria: {
        none: 'Nessuno strumento.',
        ...Object.fromEntries(
          input.toolCategories.map((c) => [c, `Strumenti della categoria ${c}.`]),
        ),
      },
    };
  }
  if (input.skillCandidates.length > 0) {
    q.skill_candidate = {
      type: 'choice',
      instructions: 'Quale skill nota può gestire la richiesta?',
      criteria: {
        none: 'Nessuna skill adatta.',
        ...Object.fromEntries(input.skillCandidates.slice(0, 5).map((s) => [s, `Skill ${s}.`])),
      },
    };
  }
  return q;
}

export function buildState(input: RouterInput): Record<string, unknown> {
  return {
    user_message: input.text.slice(0, 4000),
    input_mode: input.inputMode,
    recent_turns: input.recentTurns.slice(-6),
    available_tool_categories: input.toolCategories,
    skill_candidates: input.skillCandidates.slice(0, 5),
  };
}

/** Decisione di sicurezza usata quando Jev non è disponibile o fallisce. */
export function fallbackDecision(
  input: RouterInput,
  latencyMs: number,
  source: RouteDecision['source'] = 'fallback',
): RouteDecision {
  return {
    route: 'llm',
    modelClass: input.sessionModelClass === 'light' ? 'standard' : input.sessionModelClass,
    deepReasoning: false,
    needsMemory: true,
    toolCategories: [],
    skillId: null,
    riskSignal: 1,
    confidence: 0,
    source,
    costUsd: 0,
    inputTokens: 0,
    latencyMs,
  };
}

function noul(res: JevResponse, name: string): number | undefined {
  const a = res.answers[name];
  return a?.type === 'noul' ? a.noul : undefined;
}
function choice(
  res: JevResponse,
  name: string,
): { choice: string; confidence: number } | undefined {
  const a = res.answers[name];
  return a?.type === 'choice' ? { choice: a.choice, confidence: a.confidence ?? 0 } : undefined;
}

/** Converte le risposte Jev in una RouteDecision applicando le soglie. Puro e testabile. */
export function mapAnswers(
  res: JevResponse,
  input: RouterInput,
  thresholds: Thresholds,
  latencyMs: number,
): RouteDecision {
  const route = choice(res, 'route');
  const klass = choice(res, 'model_class');
  const deep = noul(res, 'deep_reasoning') ?? 0;
  const memory = noul(res, 'needs_memory') ?? 1;
  const risk = noul(res, 'risk') ?? 1;
  const tool = choice(res, 'tool_category');
  const skill = choice(res, 'skill_candidate');
  const ambiguity = noul(res, 'ambiguous');
  const correction = noul(res, 'correction');

  const routeKind: RouteDecision['route'] =
    route &&
    route.confidence >= thresholds.routeConfidence &&
    (route.choice === 'deterministic' || route.choice === 'skill' || route.choice === 'llm')
      ? route.choice
      : 'llm';
  const deepReasoning = deep >= thresholds.deepReasoning;
  let modelClass: RouteDecision['modelClass'] =
    klass && klass.confidence >= thresholds.classConfidence && klass.choice === 'heavy'
      ? 'heavy'
      : 'standard';
  if (deepReasoning) modelClass = 'heavy';
  const requestedModelClass: RouteDecision['requestedModelClass'] =
    modelClass === 'heavy'
      ? 'heavy'
      : klass?.choice === 'standard' && klass.confidence >= thresholds.lowerClassConfidence
        ? 'standard'
        : undefined;
  // Isteresi: dentro il turno la classe della sessione non scende; la discesa dopo due domande semplici di fila la
  // decide la connessione con `requestedModelClass`.
  if (CLASS_RANK[modelClass] < CLASS_RANK[input.sessionModelClass])
    modelClass = input.sessionModelClass;

  const toolCategories =
    tool && tool.choice !== 'none' && input.toolCategories.includes(tool.choice)
      ? [tool.choice]
      : [];
  const skillId =
    skill && skill.choice !== 'none' && input.skillCandidates.includes(skill.choice)
      ? skill.choice
      : null;
  const confidence = Math.min(route?.confidence ?? 0, klass?.confidence ?? 1);

  return {
    route: routeKind === 'skill' && !skillId ? 'llm' : routeKind,
    modelClass,
    deepReasoning,
    needsMemory: memory >= thresholds.needsMemory,
    toolCategories,
    skillId,
    riskSignal: risk,
    confidence,
    source: 'jev',
    costUsd: res.usage?.cost ?? 0,
    inputTokens: res.usage?.input_tokens ?? 0,
    latencyMs,
    ...(res.model ? { jevModel: res.model } : {}),
    ...(res.id ? { jevId: res.id } : {}),
    raw: res.answers,
    ...(ambiguity === undefined ? {} : { ambiguity }),
    ...(correction === undefined ? {} : { correction }),
    ...(requestedModelClass ? { requestedModelClass } : {}),
  };
}

export interface DecisionRouter {
  decide(input: RouterInput): Promise<RouteDecision>;
}

/**
 * Router JEV: cache esatta → Jev (una chiamata, timeout) → fallback deterministico.
 * Non applica autorizzazioni: quelle spettano al Policy Engine.
 */
export function createDecisionRouter(opts: RouterOptions): DecisionRouter {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const ttl = opts.cacheTtlSeconds ?? 600;
  return {
    async decide(input) {
      const t0 = Date.now();
      const fingerprint =
        input.contextFingerprint ??
        `${input.toolCategories.join(',')}|${input.skillCandidates.join(',')}|${input.sessionModelClass}`;
      const key = decisionCacheKey(input.text, fingerprint);
      const cached = await opts.cache?.get(key);
      if (cached)
        return {
          ...cached,
          source: 'cache',
          costUsd: 0,
          inputTokens: 0,
          latencyMs: Date.now() - t0,
        };
      if (!opts.client) return fallbackDecision(input, Date.now() - t0);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await opts.client.decide(
          {
            ...(opts.model ? { model: opts.model } : {}),
            state: buildState(input),
            questions: buildQuestions(input),
          },
          { signal: ac.signal },
        );
        const decision = mapAnswers(res, input, thresholds, Date.now() - t0);
        await opts.cache?.set(key, decision, ttl);
        return decision;
      } catch (err) {
        opts.logger?.warn(
          { err: err instanceof Error ? err.message : String(err), timeoutMs },
          'router Jev: fallback',
        );
        return fallbackDecision(input, Date.now() - t0);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
