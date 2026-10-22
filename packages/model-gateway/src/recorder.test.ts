import type { Pool } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { describe, expect, it, vi } from 'vitest';
import { createLlmCallRecorder } from './recorder.js';
import { normalizeUsage } from './usage.js';

describe('attribuzione del costo al servizio che lo ha sostenuto', () => {
  it('registra OpenRouter dopo il fallback e Anthropic per le stime dirette', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, release: vi.fn() };
    const pool = { connect: async () => client } as unknown as Pool;
    const recorder = createLlmCallRecorder(pool, createLogger({ level: 'silent', name: 'test' }));
    for (const reported of [0.002, undefined]) {
      await recorder.record({
        userId: '6b39d2b4-957f-4d21-8491-ed20ce568c77',
        sessionId: null,
        requestId: 'cost-test',
        stepIndex: 0,
        purpose: 'turn',
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-5.5',
        modelClass: 'standard',
        generationId: null,
        usage: {
          ...normalizeUsage({ inputTokens: 100, outputTokens: 10 }),
          costReportedUsd: reported,
        },
        ttftMs: null,
        latencyMs: 1,
        finishReason: 'stop',
      });
    }
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    const inserts = calls.filter(([sql]) => sql.includes('INSERT INTO llm_calls'));
    expect(inserts.map(([, values]) => values[5])).toEqual(['openrouter', 'anthropic']);
    expect(inserts.map(([, values]) => values[16])).toEqual(['provider', 'pricelist']);
  });
});
