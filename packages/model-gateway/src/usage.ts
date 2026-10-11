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
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Normalizza l'usage di uno step Mastra (spike M2.1: `usage.raw.inputTokens.{cacheRead,cacheWrite}`,
 * `usage.raw.outputTokens.reasoning`, `usage.raw.raw.cost`) e l'eventuale `providerMetadata.openrouter.usage.cost`.
 */
export function normalizeUsage(usage: unknown, providerMetadata?: unknown): NormalizedUsage {
  const u = rec(usage) ?? {};
  const raw = rec(u.raw) ?? {};
  const rawIn = rec(raw.inputTokens) ?? {};
  const rawOut = rec(raw.outputTokens) ?? {};
  const rawRaw = rec(raw.raw) ?? {};
  const orUsage = rec(rec(rec(providerMetadata)?.openrouter)?.usage) ?? {};

  const cacheRead = num(u.cachedInputTokens) || num(rawIn.cacheRead);
  const cacheWrite = num(u.cacheCreationInputTokens) || num(rawIn.cacheWrite);
  const inputTotal = num(u.inputTokens) || num(rawIn.total);
  const reasoning = num(u.reasoningTokens) || num(rawOut.reasoning);
  const output = num(u.outputTokens) || num(rawOut.total);
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
