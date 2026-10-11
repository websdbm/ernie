import { describe, expect, it } from 'vitest';
import { buildProfiles, priceFor } from './models.js';
import { estimateCostUsd, normalizeUsage } from './usage.js';

describe('normalizeUsage', () => {
  it('legge la forma Mastra osservata nello spike M2.1', () => {
    const usage = {
      inputTokens: 5781,
      outputTokens: 4,
      totalTokens: 5785,
      reasoningTokens: 0,
      cachedInputTokens: 5777,
      cacheCreationInputTokens: 0,
      raw: {
        inputTokens: { total: 5781, noCache: 4, cacheRead: 5777, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
        raw: { prompt_tokens: 5781, completion_tokens: 4, cost: 0.00006017 },
      },
    };
    const n = normalizeUsage(usage);
    expect(n).toEqual({
      inputTokens: 5781,
      cacheReadTokens: 5777,
      cacheWriteTokens: 0,
      outputTokens: 4,
      reasoningTokens: 0,
      costReportedUsd: 0.00006017,
    });
  });

  it('preferisce il costo in providerMetadata e tollera usage parziale', () => {
    const n = normalizeUsage(
      { inputTokens: 100, outputTokens: 10 },
      { openrouter: { usage: { cost: 0.5 } } },
    );
    expect(n.costReportedUsd).toBe(0.5);
    expect(n.cacheReadTokens).toBe(0);
    expect(normalizeUsage(undefined).costReportedUsd).toBeUndefined();
  });
});

describe('estimateCostUsd', () => {
  const price = priceFor('anthropic/claude-haiku-5.5');

  it('riproduce entro il 5% i costi misurati nello spike', () => {
    // B1: 5781 input di cui 5777 scritti in cache, 4 output → 0.000724525 USD riportati.
    const b1 = estimateCostUsd(
      {
        inputTokens: 5781,
        cacheReadTokens: 0,
        cacheWriteTokens: 5777,
        outputTokens: 4,
        reasoningTokens: 0,
        costReportedUsd: undefined,
      },
      price,
    );
    expect(Math.abs(b1 - 0.000724525) / 0.000724525).toBeLessThan(0.05);
    // B2: 5777 letti dalla cache → 0.00006017 USD.
    const b2 = estimateCostUsd(
      {
        inputTokens: 5781,
        cacheReadTokens: 5777,
        cacheWriteTokens: 0,
        outputTokens: 4,
        reasoningTokens: 0,
        costReportedUsd: undefined,
      },
      price,
    );
    expect(Math.abs(b2 - 0.00006017) / 0.00006017).toBeLessThan(0.05);
  });

  it('senza listino stima 0 (il costo riportato resta la fonte di verità)', () => {
    expect(
      estimateCostUsd(
        {
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          costReportedUsd: undefined,
        },
        undefined,
      ),
    ).toBe(0);
  });
});

describe('buildProfiles', () => {
  it('assegna tetti di output e ragionamento per classe', () => {
    const p = buildProfiles({ light: 'a', standard: 'b', heavy: 'c' });
    expect(p.light.reasoning).toBe('none');
    expect(p.heavy.maxOutputTokens).toBeGreaterThan(p.standard.maxOutputTokens);
    expect(p.standard.modelId).toBe('b');
  });
});
