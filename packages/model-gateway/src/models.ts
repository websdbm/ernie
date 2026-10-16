import { z } from 'zod';

export const ModelClass = z.enum(['light', 'standard', 'heavy']);
export type ModelClass = z.infer<typeof ModelClass>;

/**
 * `none` lascia il ragionamento al provider (sui modelli 5.x a volte ragionano lo stesso); `off` lo spegne davvero
 * (16 ott 2026: nei turni standard la prima risposta passava da 2,2 a 5,7 s quando il modello ragionava).
 */
export type ReasoningEffort = 'off' | 'none' | 'low' | 'medium' | 'high';

export interface ClassProfile {
  readonly modelClass: ModelClass;
  readonly modelId: string;
  /** Tetto di output per chiamata, comprensivo dei token di ragionamento (spike M2.1). */
  readonly maxOutputTokens: number;
  /** Configurazione di ragionamento fissa per sessione: cambiarla invalida la cache. */
  readonly reasoning: ReasoningEffort;
  readonly maxSteps: number;
}

export interface ModelPrice {
  /** USD per milione di token. */
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM: number;
}

/**
 * Listino verificato su GET https://openrouter.ai/api/v1/models l'11 ottobre 2026.
 * Serve per la stima; il costo riportato dal provider ha sempre la precedenza.
 */
export const PRICE_LIST: Readonly<Record<string, ModelPrice>> = {
  'anthropic/claude-haiku-5.5': {
    inputPerM: 0.1,
    outputPerM: 0.5,
    cacheReadPerM: 0.01,
    cacheWritePerM: 0.125,
  },
  'anthropic/claude-sonnet-5.5': {
    inputPerM: 2,
    outputPerM: 10,
    cacheReadPerM: 0.1,
    cacheWritePerM: 2.5,
  },
  'anthropic/claude-opus-5.5': {
    inputPerM: 4,
    outputPerM: 20,
    cacheReadPerM: 0.2,
    cacheWritePerM: 5,
  },
  'anthropic/claude-haiku-4.5': {
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheWritePerM: 1.25,
  },
  'anthropic/claude-sonnet-4.5': {
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75,
  },
};

export const PRICE_LIST_VERSION = '2026-10-11';

export interface ClassModelIds {
  readonly light: string;
  readonly standard: string;
  readonly heavy: string;
  /** Ragionamento dei turni standard (MODEL_STANDARD_REASONING): `off` per risposte più rapide, `low` come prima. */
  readonly standardReasoning?: ReasoningEffort;
}

export function buildProfiles(ids: ClassModelIds): Readonly<Record<ModelClass, ClassProfile>> {
  return {
    light: {
      modelClass: 'light',
      modelId: ids.light,
      maxOutputTokens: 1_024,
      reasoning: 'none',
      maxSteps: 2,
    },
    standard: {
      modelClass: 'standard',
      modelId: ids.standard,
      maxOutputTokens: 4_096,
      reasoning: ids.standardReasoning ?? 'low',
      maxSteps: 6,
    },
    heavy: {
      modelClass: 'heavy',
      modelId: ids.heavy,
      maxOutputTokens: 16_384,
      reasoning: 'high',
      maxSteps: 10,
    },
  };
}

export function priceFor(modelId: string): ModelPrice | undefined {
  return PRICE_LIST[modelId];
}
