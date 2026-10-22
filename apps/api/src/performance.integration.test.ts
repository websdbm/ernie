import { randomUUID } from 'node:crypto';
import { loadConfig } from '@ernie/config';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthenticator, generateApiKey } from './auth.js';
import { createPerformanceStore, type PerformanceObservation } from './performance.js';
import { type AppServer, buildServer } from './server.js';

describe.skipIf(!process.env.MIGRATIONS_DATABASE_URL || !process.env.DATABASE_URL)(
  'performance PostgreSQL/RLS/REST',
  () => {
    const ids = [randomUUID(), randomUUID()] as const;
    const sessions = [randomUUID(), randomUUID()] as const;
    const keys = [generateApiKey(), generateApiKey()];
    let owner: Pool, pool: Pool, server: AppServer;
    const observation = (extra: Partial<PerformanceObservation> = {}): PerformanceObservation => ({
      sessionId: sessions[0],
      requestId: randomUUID(),
      source: 'ios',
      appVersion: '91',
      inputMode: 'text',
      outcome: 'completed',
      reconnected: false,
      metrics: { firstContentMs: 400, completedMs: 1000 },
      ...extra,
    });
    const headers = (index = 0) => ({ authorization: `Bearer ${keys[index]?.key}` });
    beforeAll(async () => {
      owner = createPool({ connectionString: process.env.MIGRATIONS_DATABASE_URL as string });
      pool = createPool({ connectionString: process.env.DATABASE_URL as string });
      for (let i = 0; i < 2; i++) {
        await owner.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [
          ids[i],
          'Performance test',
        ]);
        await owner.query(
          "INSERT INTO api_keys(user_id,label,key_hash,scopes) VALUES($1,'performance-test',$2,ARRAY['chat'])",
          [ids[i], keys[i]?.hash],
        );
        await owner.query('INSERT INTO sessions(id,user_id,client_platform) VALUES($1,$2,$3)', [
          sessions[i],
          ids[i],
          'benchmark',
        ]);
      }
      server = await buildServer({
        config: loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
        logger: createLogger({ level: 'silent', name: 'performance-test' }),
        checks: {},
        performance: {
          authenticator: createAuthenticator(pool),
          allowedOrigins: [],
          store: createPerformanceStore(pool),
        },
      });
    });
    afterAll(async () => {
      await server?.close();
      if (owner) {
        await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
        await owner.query('DELETE FROM usage_accounts WHERE user_id=ANY($1::uuid[])', [ids]);
      }
      await Promise.all([owner?.end(), pool?.end()]);
    });
    it('autentica e accetta una sola osservazione anche dopo ritentativi', async () => {
      const o = observation();
      const payload = { observations: [o] };
      expect(
        (await server.inject({ method: 'POST', url: '/v1/performance/observations', payload }))
          .statusCode,
      ).toBe(401);
      const first = await server.inject({
        method: 'POST',
        url: '/v1/performance/observations',
        headers: headers(),
        payload,
      });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toEqual({ accepted: 1 });
      expect(first.headers['cache-control']).toBe('no-store');
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/performance/observations',
            headers: headers(),
            payload,
          })
        ).json(),
      ).toEqual({ accepted: 0 });
      const rows = await owner.query(
        'SELECT metrics FROM performance_observations WHERE request_id=$1',
        [o.requestId],
      );
      expect(rows.rows).toEqual([{ metrics: o.metrics }]);
    });
    it('isola account, sessioni e rollback del batch misto', async () => {
      const a = observation();
      const response = await server.inject({
        method: 'POST',
        url: '/v1/performance/observations',
        headers: headers(),
        payload: { observations: [a, observation({ sessionId: sessions[1] })] },
      });
      expect(response.statusCode).toBe(404);
      expect(
        (
          await owner.query('SELECT 1 FROM performance_observations WHERE request_id=$1', [
            a.requestId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await server.inject({ method: 'GET', url: '/v1/performance', headers: headers(1) })).json()
          .groups,
      ).toEqual([]);
      expect(
        (await withUser(pool, ids[1], (c) => c.query('SELECT * FROM performance_observations')))
          .rowCount,
      ).toBe(0);
    });
    it('rifiuta payload arbitrari, misure server e periodi eccessivi', async () => {
      for (const o of [
        observation({ source: 'server' }),
        { ...observation(), prompt: 'privato' },
        observation({ metrics: { completedMs: 9999999 } }),
      ])
        expect(
          (
            await server.inject({
              method: 'POST',
              url: '/v1/performance/observations',
              headers: headers(),
              payload: { observations: [o] },
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: '/v1/performance?days=1000',
            headers: headers(),
          })
        ).statusCode,
      ).toBe(400);
    });
  },
);
