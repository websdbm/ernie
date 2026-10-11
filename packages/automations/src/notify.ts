import type { AgentEvent, EventType, PayloadInputOf } from '@ernie/protocol';
import type { Redis } from 'ioredis';

/** Canale Redis pub/sub: il worker pubblica eventi per utente, l'API li inoltra alle sessioni connesse. */
export const USER_EVENTS_CHANNEL = 'ernie:user-events';

export interface UserEventMessage<T extends EventType = EventType> {
  readonly userId: string;
  readonly type: T;
  readonly payload: PayloadInputOf<T>;
}

export async function publishUserEvent<T extends EventType>(
  redis: Pick<Redis, 'publish'>,
  msg: UserEventMessage<T>,
): Promise<void> {
  await redis.publish(USER_EVENTS_CHANNEL, JSON.stringify(msg));
}

/** Sottoscrive il canale con una connessione dedicata (Redis in modalità subscriber non accetta altri comandi). */
export async function subscribeUserEvents(
  subscriber: Redis,
  onMessage: (msg: UserEventMessage) => void,
): Promise<() => Promise<void>> {
  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== USER_EVENTS_CHANNEL) return;
    try {
      const parsed = JSON.parse(raw) as UserEventMessage;
      if (parsed && typeof parsed.userId === 'string' && typeof parsed.type === 'string')
        onMessage(parsed);
    } catch {
      /* messaggio corrotto: ignorato */
    }
  });
  await subscriber.subscribe(USER_EVENTS_CHANNEL);
  return async () => {
    await subscriber.unsubscribe(USER_EVENTS_CHANNEL);
  };
}

export type { AgentEvent };
