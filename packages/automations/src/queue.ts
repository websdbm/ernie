import { type ConnectionOptions, type JobsOptions, Queue } from 'bullmq';
import { dedupeKeys } from './schedule.js';
import { AUTOMATION_QUEUE, type Automation, type RunJobData, type TickJobData } from './schema.js';

export type AutomationQueue = Queue;

export function createAutomationQueue(connection: ConnectionOptions): AutomationQueue {
  return new Queue(AUTOMATION_QUEUE, { connection });
}

export const RUN_ATTEMPTS = 3;

const runOpts = (delayMs: number, jobId: string): JobsOptions => ({
  jobId,
  delay: Math.max(0, delayMs),
  attempts: RUN_ATTEMPTS,
  backoff: { type: 'automation' },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
});

/** Accoda una run; il jobId coincide con la chiave di idempotenza (BullMQ ignora un job con id già presente). */
export async function enqueueRun(
  queue: AutomationQueue,
  data: RunJobData,
  delayMs = 0,
): Promise<{ enqueued: boolean; jobId: string }> {
  // BullMQ 6 vieta i due punti negli id personalizzati: la chiave resta leggibile nel database, qui viene normalizzata.
  const jobId = `run_${data.automationId}_${data.dedupeKey}`.replace(/[^\w.-]/g, '_');
  // Controllo informativo (la deduplica vera è nel database): BullMQ ignora un add con jobId già presente.
  if (await queue.getJob(jobId)) return { enqueued: false, jobId };
  await queue.add('run', data, runOpts(delayMs, jobId));
  return { enqueued: true, jobId };
}

const schedulerId = (a: Automation) => `auto_${a.id}_v${a.version}`;

/**
 * Allinea i job scheduler BullMQ alle automazioni abilitate: cron → job scheduler (`tick`) con fuso IANA;
 * una tantum → job `run` ritardato con chiave `once:<istante>`; webhook ed eventi non hanno scheduler.
 * Idempotente: può girare su più worker; la deduplica delle run avviene nel database.
 */
export async function syncSchedulers(
  queue: AutomationQueue,
  enabled: readonly Automation[],
  now = new Date(),
): Promise<{ upserted: number; removed: number; onceEnqueued: number }> {
  const wanted = new Map<string, Automation>();
  for (const a of enabled) if (a.trigger.type === 'cron') wanted.set(schedulerId(a), a);

  let removed = 0;
  const existing = await queue.getJobSchedulers(0, -1, true);
  for (const s of existing) {
    // `auto:` è il prefisso delle prime build (id con due punti): rimosso come qualunque scheduler non più voluto.
    if ((s.key.startsWith('auto_') || s.key.startsWith('auto:')) && !wanted.has(s.key)) {
      await queue.removeJobScheduler(s.key);
      removed++;
    }
  }
  let upserted = 0;
  for (const [id, a] of wanted) {
    if (a.trigger.type !== 'cron') continue;
    const data: TickJobData = { automationId: a.id, userId: a.userId };
    await queue.upsertJobScheduler(
      id,
      { pattern: a.trigger.pattern, tz: a.timezone },
      {
        name: 'tick',
        data,
        opts: { removeOnComplete: 50, removeOnFail: 100 },
      },
    );
    upserted++;
  }
  let onceEnqueued = 0;
  for (const a of enabled) {
    if (a.trigger.type !== 'once') continue;
    const at = new Date(a.trigger.at);
    if (at.getTime() < now.getTime() - 24 * 3600_000) continue; // vecchia di oltre un giorno: non recuperata
    const res = await enqueueRun(
      queue,
      {
        automationId: a.id,
        userId: a.userId,
        scheduledAt: at.toISOString(),
        dedupeKey: dedupeKeys.once(at),
        triggerType: 'once',
        depth: 0,
      },
      at.getTime() - now.getTime(),
    );
    if (res.enqueued) onceEnqueued++;
  }
  return { upserted, removed, onceEnqueued };
}

/** Backoff per i retry delle run: esponenziale con jitter (solo errori transitori arrivano qui). */
export function automationBackoff(attemptsMade: number, random = Math.random): number {
  const base = 30_000 * 2 ** Math.max(0, attemptsMade - 1);
  return Math.min(base + Math.floor(random() * 15_000), 10 * 60_000);
}
