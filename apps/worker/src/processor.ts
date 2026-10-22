import type { Logger } from '@ernie/observability';
import { SYSTEM_HEARTBEAT_CHANNEL } from '@ernie/protocol';

export const SYSTEM_QUEUE = 'system';
export const HEARTBEAT_KEY = 'ernie:worker:heartbeat';
export const HEARTBEAT_EVERY_MS = 60_000;

export type SystemJobName = 'heartbeat' | 'ping';

export interface SystemJob {
  readonly name: string;
  readonly id?: string | undefined;
  readonly data: unknown;
}

export interface HeartbeatStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export interface ProcessorDeps {
  readonly store: HeartbeatStore;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
  readonly now?: () => Date;
  readonly publishHeartbeat?: (channel: string, at: string) => Promise<unknown>;
}

export class UnknownJobError extends Error {
  override readonly name = 'UnknownJobError';
}

/**
 * Processore della coda `system`. Deterministico: nessuna chiamata LLM.
 * - heartbeat: scrive in Redis un timestamp con TTL, usato come segnale di vitalità del worker.
 * - ping: restituisce il payload ricevuto (utile per test end-to-end della coda).
 */
export function createSystemProcessor(deps: ProcessorDeps) {
  const now = deps.now ?? (() => new Date());
  return async function processSystemJob(job: SystemJob): Promise<unknown> {
    switch (job.name as SystemJobName) {
      case 'heartbeat': {
        const at = now().toISOString();
        await deps.store.set(HEARTBEAT_KEY, at, 'EX', Math.ceil((HEARTBEAT_EVERY_MS * 3) / 1000));
        await deps.publishHeartbeat?.(SYSTEM_HEARTBEAT_CHANNEL, at);
        deps.logger.debug({ at }, 'heartbeat');
        return { at };
      }
      case 'ping':
        return { pong: true, echo: job.data, at: now().toISOString() };
      default:
        throw new UnknownJobError(`job sconosciuto sulla coda ${SYSTEM_QUEUE}: ${job.name}`);
    }
  };
}
