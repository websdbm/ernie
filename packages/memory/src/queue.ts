import { createHash } from 'node:crypto';
import { type ConnectionOptions, Queue } from 'bullmq';
import type { TurnEpisodeInput } from './episodes.js';

export const MEMORY_QUEUE = 'memory';

export interface ConsolidateJobData {
  readonly userId: string;
  readonly threadId: string;
  readonly sessionId: string;
}
export interface SummarizeJobData {
  readonly userId: string;
  readonly sessionId: string;
}
export interface PurgeJobData {
  readonly retentionDays: number;
}

export type MemoryQueue = Queue;

export function createMemoryQueue(connection: ConnectionOptions): MemoryQueue {
  return new Queue(MEMORY_QUEUE, { connection });
}

/**
 * Accoda il consolidamento con debounce: un solo job in attesa e al massimo un seguito quando è attivo.
 * Un turno arrivato dopo il completamento deve sempre poter creare un nuovo job.
 */
export async function enqueueConsolidation(
  queue: MemoryQueue,
  data: ConsolidateJobData,
  delayMs = 15_000,
): Promise<void> {
  await queue.add('consolidate', data, {
    // Debounce finché in attesa; se attivo conserva un ultimo job e non esegue lo stesso thread in parallelo.
    deduplication: {
      id: `consolidate_${createHash('sha256').update(`${data.userId}:${data.threadId}`).digest('hex')}`,
      replace: true,
      keepLastIfActive: true,
    },
    delay: delayMs,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

/** Riassunto della conversazione dopo un turno (debounce e serializzazione per sessione). */
export async function enqueueSessionSummary(
  queue: MemoryQueue,
  data: SummarizeJobData,
  delayMs = 3_000,
): Promise<void> {
  await queue.add('summarize', data, {
    deduplication: {
      id: `summarize_${createHash('sha256').update(`${data.userId}:${data.sessionId}`).digest('hex')}`,
      replace: true,
      keepLastIfActive: true,
    },
    delay: delayMs,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

export async function ensurePurgeSchedule(
  queue: MemoryQueue,
  retentionDays: number,
): Promise<void> {
  await queue.upsertJobScheduler(
    'memory-purge',
    { pattern: '30 3 * * *' },
    { name: 'purge', data: { retentionDays }, opts: { removeOnComplete: 10, removeOnFail: 20 } },
  );
}

export interface TurnMemoryJobData {
  readonly episode: TurnEpisodeInput;
  readonly consolidationDelayMs: number;
}

/** L'API attende solo l'accettazione Redis; i fallimenti del worker restano ritentabili e visibili. */
export async function enqueueTurnMemory(
  queue: MemoryQueue,
  data: TurnMemoryJobData,
): Promise<void> {
  const key = createHash('sha256')
    .update(`${data.episode.userId}:${data.episode.sessionId}:${data.episode.requestId}`)
    .digest('hex');
  const queued = {
    ...data,
    episode: {
      ...data.episode,
      userText: data.episode.userText.replace(/\s+/g, ' ').trim().slice(0, 140),
    },
  };
  await queue.add('turn-memory', queued, {
    jobId: `turn_${key}`,
    attempts: 8,
    backoff: { type: 'exponential', delay: 3_000 },
    removeOnComplete: { age: 7 * 86400, count: 10_000 },
    removeOnFail: false,
  });
}
