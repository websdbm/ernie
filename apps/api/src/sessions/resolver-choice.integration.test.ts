import { randomUUID } from 'node:crypto';
import type { Pool } from '@ernie/db';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { createSessionStore } from './store.js';

describe.skipIf(!process.env.TEST_RESOLVER_REDIS_URL)('resolver con Redis reale', () => {
  it('sopravvive al cambio istanza, scade e viene consumato una sola volta per account/sessione', async () => {
    const redis = new Redis(process.env.TEST_RESOLVER_REDIS_URL as string);
    const a = createSessionStore(null as unknown as Pool, redis),
      b = createSessionStore(null as unknown as Pool, redis);
    const user = randomUUID(),
      session = randomUUID(),
      key = `ernie:resolver:${user}:${session}`;
    const choice = {
      message: 'Passare in laboratorio alle 19:30',
      question: 'Che risultato vuoi?',
      kind: 'capability' as const,
      options: [
        { label: 'Promemoria', value: 'ricordami' },
        { label: 'Consiglio', value: 'none' },
      ],
      createdAt: Date.now(),
    };
    try {
      await a.saveResolverChoice(user, session, choice);
      expect(await redis.ttl(key)).toBeGreaterThan(590);
      expect(await b.takeResolverChoice(randomUUID(), session)).toBeNull();
      expect(await b.takeResolverChoice(user, randomUUID())).toBeNull();
      const taken = await Promise.all([
        a.takeResolverChoice(user, session),
        b.takeResolverChoice(user, session),
      ]);
      expect(taken.filter(Boolean)).toEqual([choice]);
      expect(await b.takeResolverChoice(user, session)).toBeNull();
      await a.saveResolverChoice(user, session, choice);
      await redis.pexpire(key, 1);
      await new Promise((r) => setTimeout(r, 10));
      expect(await b.takeResolverChoice(user, session)).toBeNull();
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  });
});
