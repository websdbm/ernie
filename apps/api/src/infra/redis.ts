import type { Logger } from '@ernie/observability';
import { Redis } from 'ioredis';

export interface RedisResource {
  readonly client: Redis;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createRedis(url: string, logger: Logger): RedisResource {
  const client = new Redis(url, {
    // Fallire presto: il readiness check non deve restare appeso se Redis è giù.
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (err) => logger.warn({ err: err.message }, 'errore connessione redis'));
  client.on('ready', () => logger.debug('redis pronto'));
  return {
    client,
    async check() {
      const pong = await client.ping();
      if (pong !== 'PONG') throw new Error(`risposta inattesa da redis: ${pong}`);
    },
    async close() {
      await client.quit();
    },
  };
}
