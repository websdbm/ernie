import { type ModelPrice, priceFor } from './models.js';

/** Token e costo di una singola chiamata HTTP al provider, normalizzati. */
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costReportedUsd: number | undefined;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' ? (v as Rec) : undefined);
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Primo valore numerico definito (anche 0): un passo senza cache vale 0, non «assente». */
const first = (...vs: unknown[]): number => {
  for (const v of vs) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
};

/**
 * Normalizza l'usage di uno step Mastra (spike M2.1: `usage.raw.inputTokens.{cacheRead,cacheWrite}`,
 * `usage.raw.outputTokens.reasoning`, `usage.raw.raw.cost`) e l'eventuale `providerMetadata.openrouter.usage.cost`.
 *
 * Si preferisce `usage.raw` (ciò che il provider ha riportato per QUELLA richiesta) ai campi di primo
 * livello: Mastra riusa l'oggetto dell'ultimo passo per il chunk `finish` e ne sovrascrive i campi di
 * primo livello con il totale del turno; se chi legge lo stream è più lento del produttore (scritture su
 * database tra un chunk e l'altro) l'ultimo `step-finish` arriva già cumulativo. `raw` resta del passo.
 * Verificato con un modello finto e un consumatore lento (`steps-usage.test.ts` in agent-core).
 */
export function normalizeUsage(usage: unknown, providerMetadata?: unknown): NormalizedUsage {
  const u = rec(usage) ?? {};
  const raw = rec(u.raw) ?? {};
  const rawIn = rec(raw.inputTokens) ?? {};
  const rawOut = rec(raw.outputTokens) ?? {};
  const rawRaw = rec(raw.raw) ?? {};
  const orUsage = rec(rec(rec(providerMetadata)?.openrouter)?.usage) ?? {};

  // Forma annidata (spec v3/v4) o piatta (v2: `raw.inputTokens` numero).
  const inputTotal = first(rawIn.total, raw.inputTokens, u.inputTokens);
  const cacheRead = first(rawIn.cacheRead, raw.cachedInputTokens, u.cachedInputTokens);
  const cacheWrite = first(
    rawIn.cacheWrite,
    raw.cacheCreationInputTokens,
    u.cacheCreationInputTokens,
  );
  const output = first(rawOut.total, raw.outputTokens, u.outputTokens);
  const reasoning = first(rawOut.reasoning, raw.reasoningTokens, u.reasoningTokens);
  const cost = optNum(orUsage.cost) ?? optNum(rawRaw.cost);

  return {
    inputTokens: inputTotal,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    costReportedUsd: cost,
  };
}

/** Stima da listino: i token in cache si pagano a tariffa ridotta, quelli scritti a tariffa maggiorata. */
export function estimateCostUsd(u: NormalizedUsage, price: ModelPrice | undefined): number {
  if (!price) return 0;
  const uncached = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens);
  const cost =
    (uncached * price.inputPerM +
      u.cacheReadTokens * price.cacheReadPerM +
      u.cacheWriteTokens * price.cacheWritePerM +
      u.outputTokens * price.outputPerM) /
    1_000_000;
  return Math.round(cost * 1e10) / 1e10;
}

export function estimateCostForModel(u: NormalizedUsage, modelId: string): number {
  return estimateCostUsd(u, priceFor(modelId));
}

/**
 * Costo di una chiamata: quello riportato dal provider se c'è (OpenRouter), altrimenti la stima da listino
 * (API di Anthropic diretta, che non riporta il costo). Va usato per i totali dei turni e per i tetti di spesa.
 */
export function callCostUsd(u: NormalizedUsage, modelId: string): number {
  return u.costReportedUsd ?? estimateCostForModel(u, modelId);
}
