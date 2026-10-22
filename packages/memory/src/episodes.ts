import {
  enqueueConsolidation,
  enqueueSessionSummary,
  type MemoryQueue,
  type TurnMemoryJobData,
} from './queue.js';
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

/** Ripetibile dopo un crash: episodio identificato dal requestId, code figlie deduplicate. */
export async function processTurnMemory(
  repo: MemoryRepository,
  queue: MemoryQueue,
  data: TurnMemoryJobData,
): Promise<void> {
  const info = data.episode;
  await recordTurnEpisode(repo, info);
  if (info.outcome === 'completed' && info.llmCalls > 0) {
    await enqueueConsolidation(
      queue,
      {
        userId: info.userId,
        threadId: info.sessionId,
        sessionId: info.sessionId,
      },
      data.consolidationDelayMs,
    );
    await enqueueSessionSummary(queue, { userId: info.userId, sessionId: info.sessionId });
  }
}
