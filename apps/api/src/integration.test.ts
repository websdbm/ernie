import { loadConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgres, type PostgresResource } from './infra/postgres.js';
import { createRedis, type RedisResource } from './infra/redis.js';
import { type AppServer, buildServer } from './server.js';

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

describe.skipIf(!hasInfra)('API con infrastruttura reale (DATABASE_URL + REDIS_URL)', () => {
  let postgres: PostgresResource;
  let redis: RedisResource;
  let app: AppServer;

  beforeAll(async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const logger = createLogger({ level: 'silent', name: 'test' });
    postgres = createPostgres(config, logger);
    redis = createRedis(config.redis.url, logger);
    app = await buildServer({
      config,
      logger,
      checks: { postgres: () => postgres.check(), redis: () => redis.check() },
    });
  });

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([postgres?.close(), redis?.close()]);
  });

  it('GET /ready è 200 con postgres e redis raggiungibili', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().checks.postgres.status).toBe('ok');
    expect(res.json().checks.redis.status).toBe('ok');
  });
});
