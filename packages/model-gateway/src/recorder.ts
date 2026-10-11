import { type Pool, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';
import { estimateCostForModel, type NormalizedUsage } from './usage.js';

export type LlmCallPurpose =
  | 'turn'
  | 'summary'
  | 'memory'
  | 'router'
  | 'skill'
  | 'automation'
  | 'document'
  | 'other';

export interface LlmCallRecord {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
  readonly stepIndex: number;
  readonly purpose: LlmCallPurpose;
  readonly provider: string;
  readonly model: string;
  readonly modelClass: string | null;
  readonly generationId: string | null;
  readonly usage: NormalizedUsage;
  readonly ttftMs: number | null;
  readonly latencyMs: number;
  readonly finishReason: string | null;
}

export interface LlmCallRecorder {
  record(call: LlmCallRecord): Promise<void>;
}

/** Una riga di `llm_calls` per chiamata HTTP (step), con costo del provider e stima da listino. */
export function createLlmCallRecorder(pool: Pool, logger: Logger): LlmCallRecorder {
  return {
    async record(c) {
      const estimated = estimateCostForModel(c.usage, c.model);
      const reported = c.usage.costReportedUsd;
      try {
        await withUser(pool, c.userId, (client) =>
          client.query(
            `INSERT INTO llm_calls (
               user_id, session_id, request_id, step_index, purpose, provider, model, model_class, generation_id,
               input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
               cost_reported_usd, cost_estimated_usd, cost_source, ttft_ms, latency_ms, finish_reason
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [
              c.userId,
              c.sessionId,
              c.requestId,
              c.stepIndex,
              c.purpose,
              c.provider,
              c.model,
              c.modelClass,
              c.generationId,
              c.usage.inputTokens,
              c.usage.cacheReadTokens,
              c.usage.cacheWriteTokens,
              c.usage.outputTokens,
              c.usage.reasoningTokens,
              reported ?? null,
              estimated,
              reported === undefined ? 'pricelist' : 'provider',
              c.ttftMs,
              c.latencyMs,
              c.finishReason,
            ],
          ),
        );
      } catch (err) {
        // La registrazione dei costi non deve far fallire il turno, ma va vista.
        logger.error({ err, requestId: c.requestId }, 'registrazione llm_calls fallita');
      }
    },
  };
}
