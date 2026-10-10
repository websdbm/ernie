import { loadConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import { afterEach, describe, expect, it } from 'vitest';
import { healthRoutes } from './routes/health.js';
import { type AppServer, buildServer } from './server.js';

const config = loadConfig({
  NODE_ENV: 'test',
  APP_VERSION: '9.9.9-test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  LOG_LEVEL: 'silent',
});
const logger = createLogger({ level: 'silent', name: 'test' });

const ok = async () => {};
const fail = async () => {
  throw new Error('connessione rifiutata');
};
const hang = () => new Promise<void>(() => {});

describe('API server', () => {
  const apps: AppServer[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function make(checks: Record<string, () => Promise<void>>) {
    const app = await buildServer({ config, logger, checks });
    apps.push(app);
    return app;
  }

  it('GET /health risponde 200 con metadati del servizio', async () => {
    const app = await make({});
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('9.9.9-test');
    expect(body.service).toBe('ernie');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('GET /ready risponde 200 quando tutte le dipendenze rispondono', async () => {
    const app = await make({ postgres: ok, redis: ok });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.postgres.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
  });

  it('GET /ready risponde 503 e indica la dipendenza guasta', async () => {
    const app = await make({ postgres: ok, redis: fail });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.postgres.status).toBe('ok');
    expect(body.checks.redis.status).toBe('fail');
    expect(body.checks.redis.error).toContain('connessione rifiutata');
  });

  it('GET /ready applica un timeout ai controlli bloccati', async () => {
    const app = await make({});
    await app.register(
      async (inst) => {
        await healthRoutes(inst, {
          service: config.service,
          env: config.env,
          checks: { slow: hang },
          checkTimeoutMs: 50,
        });
      },
      { prefix: '/t' },
    );
    const res = await app.inject({ method: 'GET', url: '/t/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.slow.error).toMatch(/timeout/);
  });

  it('propaga o genera x-request-id', async () => {
    const app = await make({});
    const given = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(given.headers['x-request-id']).toBe('req-123');

    const generated = await app.inject({ method: 'GET', url: '/health' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('risponde 404 in JSON per rotte sconosciute', async () => {
    const app = await make({});
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
