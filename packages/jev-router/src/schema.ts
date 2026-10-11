import { z } from 'zod';

/**
 * Decisions API di Jev (TypeSafe su OpenRouter) — contratto verificato il 10 ott 2026
 * (docs: openrouter.ai/docs/guides/community/jev e jev-tutorial). API in alpha: questo file
 * è l'unico punto che ne conosce la forma.
 */
export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13';
export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

// ---------- richiesta ----------

export const NoulQuestion = z.object({
  type: z.literal('noul'),
  instructions: z.string().min(1),
  criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }),
});
export const ChoiceQuestion = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1),
  criteria: z
    .record(z.string(), z.string().min(1))
    .refine((c) => Object.keys(c).length >= 2, 'servono almeno due opzioni'),
});
export const ScoreQuestion = z.object({
  type: z.literal('score'),
  instructions: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(2),
});
export const JevQuestion = z.discriminatedUnion('type', [
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
]);
export type JevQuestion = z.infer<typeof JevQuestion>;

export const JevRequest = z.object({
  model: z.string().min(1),
  state: z.record(z.string(), z.unknown()),
  questions: z.record(z.string(), JevQuestion),
});
export type JevRequest = z.infer<typeof JevRequest>;

// ---------- risposta ----------

export const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
export const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().optional(),
});
export const ScoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
  legend: z.record(z.string(), z.string()).optional(),
  confidence: z.number().optional(),
});
export const JevAnswer = z.discriminatedUnion('type', [NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type JevAnswer = z.infer<typeof JevAnswer>;

export const JevResponse = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  answers: z.record(z.string(), JevAnswer),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .partial()
    .optional(),
});
export type JevResponse = z.infer<typeof JevResponse>;

// ---------- decisione di Ernie ----------

export const RouteKind = z.enum(['deterministic', 'skill', 'llm']);
export const ModelClass = z.enum(['light', 'standard', 'heavy']);
export const DecisionSource = z.enum(['deterministic', 'jev', 'cache', 'fallback']);

export const RouteDecision = z.object({
  route: RouteKind,
  modelClass: ModelClass,
  deepReasoning: z.boolean(),
  needsMemory: z.boolean(),
  toolCategories: z.array(z.string()),
  skillId: z.string().nullable(),
  /** P(la richiesta implica azioni esterne o dati sensibili): può solo restringere la policy. */
  riskSignal: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  source: DecisionSource,
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  jevModel: z.string().optional(),
  jevId: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

/** Soglie per le domande noul: da tarare su dati etichettati, mai 0,5 di default (03-revisione A.11). */
export const Thresholds = z.object({
  deepReasoning: z.number().min(0).max(1),
  needsMemory: z.number().min(0).max(1),
  risk: z.number().min(0).max(1),
  /** Sotto questa confidenza la scelta di `route` ricade sul gradino più sicuro (`llm`). */
  routeConfidence: z.number().min(0).max(1),
  /** Sotto questa confidenza `model_class` ricade su `standard`. */
  classConfidence: z.number().min(0).max(1),
});
export type Thresholds = z.infer<typeof Thresholds>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  deepReasoning: 0.6,
  needsMemory: 0.55,
  risk: 0.45,
  routeConfidence: 0.5,
  classConfidence: 0.5,
};
