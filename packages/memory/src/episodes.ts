import type { MemoryRepository } from './repository.js';

export interface TurnEpisodeInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly userText: string;
  readonly route: string;
  readonly modelClass: string;
  readonly model?: string;
  readonly outcome: 'completed' | 'cancelled' | 'error' | 'loop';
  readonly costUsd: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly latencyMs: number;
}

/** Episodio deterministico di un turno (nessun LLM): cosa è stato chiesto, come è stato gestito, con quale esito. */
export async function recordTurnEpisode(
  repo: MemoryRepository,
  e: TurnEpisodeInput,
): Promise<void> {
  const text = e.userText.replace(/\s+/g, ' ').trim().slice(0, 140);
  const esito = {
    completed: 'completato',
    cancelled: "annullato dall'utente",
    error: 'fallito',
    loop: 'interrotto per loop',
  }[e.outcome];
  const content = `Turno ${esito}: «${text}» gestito via ${e.route}/${e.modelClass}${e.model ? ` (${e.model})` : ''}, ${e.llmCalls} chiamate LLM, ${e.toolCalls} tool, ${e.costUsd.toFixed(5)} USD, ${Math.round(e.latencyMs / 100) / 10} s.`;
  await repo.remember({
    userId: e.userId,
    kind: 'episodic',
    category: e.outcome === 'completed' ? 'outcome' : 'error',
    content,
    provenance: { source: 'system', trust: 1, sessionId: e.sessionId, requestId: e.requestId },
    confidence: 1,
  });
}
