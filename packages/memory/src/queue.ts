import { type ConnectionOptions, Queue } from 'bullmq';

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
 * Accoda il consolidamento di un thread con un ritardo: l'id del job ha una finestra di un minuto,
 * così più turni ravvicinati producono un solo job (debounce senza stato).
 */
export async function enqueueConsolidation(
  queue: MemoryQueue,
  data: ConsolidateJobData,
  delayMs = 15_000,
): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  await queue.add('consolidate', data, {
    // BullMQ 6 vieta i due punti negli id personalizzati.
    jobId: `consolidate_${data.threadId}_${bucket}`,
    delay: delayMs,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

/** Riassunto della conversazione dopo un turno (debounce di un minuto come il consolidamento). */
export async function enqueueSessionSummary(
  queue: MemoryQueue,
  data: SummarizeJobData,
  delayMs = 3_000,
): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  await queue.add('summarize', data, {
    jobId: `summarize_${data.sessionId}_${bucket}`,
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
