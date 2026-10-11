import { type Pool, withUser } from '@ernie/db';
import type { RouteDecision } from '@ernie/jev-router';
import type { Logger } from '@ernie/observability';

export interface RouterDecisionRecorder {
  record(
    userId: string,
    sessionId: string | null,
    requestId: string,
    decision: RouteDecision,
  ): Promise<void>;
}

/** Una riga in router_decisions per ogni richiesta instradata (anche deterministica): metriche e audit. */
export function createRouterDecisionRecorder(pool: Pool, logger: Logger): RouterDecisionRecorder {
  return {
    async record(userId, sessionId, requestId, d) {
      try {
        await withUser(pool, userId, (client) =>
          client.query(
            `INSERT INTO router_decisions (user_id, session_id, request_id, source, route, model_class, deep_reasoning, needs_memory,
               tool_categories, skill_id, risk_signal, confidence, input_tokens, cost_usd, latency_ms, jev_model, jev_id, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
              userId,
              sessionId,
              requestId,
              d.source,
              d.route,
              d.modelClass,
              d.deepReasoning,
              d.needsMemory,
              d.toolCategories,
              d.skillId,
              d.riskSignal,
              d.confidence,
              d.inputTokens,
              d.costUsd,
              d.latencyMs,
              d.jevModel ?? null,
              d.jevId ?? null,
              d.raw ? JSON.stringify(d.raw) : null,
            ],
          ),
        );
      } catch (err) {
        logger.error({ err, requestId }, 'registrazione router_decisions fallita');
      }
    },
  };
}
