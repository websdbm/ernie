import { randomUUID } from 'node:crypto';
import type { Logger } from '@ernie/observability';
import { type AutomationQueue, enqueueRun } from './queue.js';
import type { AutomationRepository } from './repository.js';
import { dedupeKeys, jitterMs } from './schedule.js';

export const EVENT_NAME = /^[a-z][a-z0-9_.]{2,63}$/;

export interface EventPublisher {
  /** Avvia le automazioni dell'utente con trigger `event` sul nome dato; l'id evento è la chiave di idempotenza. */
  publish(
    userId: string,
    eventName: string,
    payload?: unknown,
    opts?: { eventId?: string },
  ): Promise<{ triggered: number; eventId: string }>;
}

/**
 * Eventi interni (es. `shopping_list.cleared`, `app.opened`). Solo l'API li pubblica, mai il worker:
 * una run di automazione non può innescarne altre (anti-ricorsione).
 */
export function createEventPublisher(deps: {
  readonly repo: AutomationRepository;
  readonly queue: AutomationQueue;
  readonly logger: Logger;
  readonly now?: () => Date;
}): EventPublisher {
  return {
    async publish(userId, eventName, payload, opts = {}) {
      if (!EVENT_NAME.test(eventName)) throw new Error(`nome evento non valido: ${eventName}`);
      const eventId = opts.eventId ?? randomUUID();
      const now = (deps.now ?? (() => new Date()))();
      const automations = await deps.repo.listByEvent(userId, eventName);
      let triggered = 0;
      for (const a of automations) {
        const res = await enqueueRun(
          deps.queue,
          {
            automationId: a.id,
            userId,
            scheduledAt: now.toISOString(),
            dedupeKey: dedupeKeys.event(eventId),
            triggerType: 'event',
            payload: { eventName, eventId, data: payload ?? null },
            depth: 0,
          },
          jitterMs(a.jitterSeconds),
        );
        if (res.enqueued) triggered++;
      }
      if (triggered)
        deps.logger.info({ userId, eventName, triggered }, 'automazioni avviate da evento');
      return { triggered, eventId };
    },
  };
}
