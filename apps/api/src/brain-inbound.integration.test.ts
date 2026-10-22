import { randomUUID } from 'node:crypto';
import type { BrainService } from '@ernie/brain';
import { createPool, type Pool } from '@ernie/db';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { brainRoutes } from './routes/brain.js';

const ready = Boolean(
  process.env.MIGRATIONS_DATABASE_URL && process.env.DATABASE_URL && process.env.REDIS_URL,
);
describe.skipIf(!ready)(
  'inoltro email: destinatari e ritentativi con PostgreSQL/RLS e Redis',
  () => {
    let owner: Pool;
    let pool: Pool;
    let redis: Redis;
    const app = Fastify();
    const users = [randomUUID(), randomUUID()];
    const tokens = users.map((id) => id.replaceAll('-', '').slice(0, 12));
    const keys = new Set<string>();
    const write = vi.fn(async () => ({ path: 'note.md' }));
    beforeAll(async () => {
      owner = createPool({ connectionString: process.env.MIGRATIONS_DATABASE_URL as string });
      pool = createPool({ connectionString: process.env.DATABASE_URL as string });
      redis = new Redis(process.env.REDIS_URL as string);
      for (const [i, id] of users.entries())
        await owner.query(
          "INSERT INTO users (id, display_name, settings) VALUES ($1, 'Review inbound', $2)",
          [id, JSON.stringify({ email: 'review@example.org', brainInboxToken: tokens[i] })],
        );
      await brainRoutes(app, {
        authenticator: { authenticate: async () => null },
        allowedOrigins: [],
        pool,
        brain: { write } as unknown as BrainService,
        inbound: { secret: 'review-secret', domain: 'brain.example.org' },
        firstSeen: async (key, ttl) => {
          keys.add(key);
          return (await redis.set(key, '1', 'EX', ttl, 'NX')) === 'OK';
        },
        forget: (key) => redis.del(key),
      });
    });
    afterAll(async () => {
      await app.close();
      if (keys.size) await redis.del(...keys);
      await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      await Promise.all([owner.end(), pool.end(), redis.quit()]);
    });
    it('lo stesso messaggio raggiunge entrambi gli account una sola volta; un errore può essere ritentato', async () => {
      const payload = {
        items: [
          {
            MessageId: randomUUID(),
            From: { Address: 'review@example.org' },
            To: tokens.map((t) => `${t}@brain.example.org`),
            Subject: 'Review',
            RawTextBody: 'Contenuto per entrambi',
          },
        ],
      };
      const send = () =>
        app.inject({ method: 'POST', url: '/v1/brain/inbound/email?key=review-secret', payload });
      write.mockRejectedValueOnce(new Error('errore transitorio'));
      expect((await send()).statusCode).toBe(500);
      const saved = await send();
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ received: 2, saved: 2 });
      expect((await send()).json()).toEqual({ received: 2, saved: 0 });
      expect(write).toHaveBeenCalledTimes(3);
      expect(write.mock.calls.slice(1).map((args) => (args as unknown[])[0])).toEqual(users);
    });
  },
);
