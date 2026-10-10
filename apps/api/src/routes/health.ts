import type { FastifyInstance } from 'fastify';

export type HealthCheck = () => Promise<void>;

export interface HealthRouteOptions {
  readonly service: { readonly name: string; readonly version: string };
  readonly env: string;
  readonly checks: Readonly<Record<string, HealthCheck>>;
  /** Tempo massimo per ciascun controllo di readiness. */
  readonly checkTimeoutMs?: number;
}

export type CheckOutcome =
  | { status: 'ok'; durationMs: number }
  | { status: 'fail'; durationMs: number; error: string };

const startedAt = Date.now();

async function withTimeout(check: HealthCheck, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout dopo ${ms}ms`)), ms);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runChecks(
  checks: Readonly<Record<string, HealthCheck>>,
  timeoutMs: number,
): Promise<Record<string, CheckOutcome>> {
  const entries = Object.entries(checks);
  const results = await Promise.all(
    entries.map(async ([name, check]): Promise<[string, CheckOutcome]> => {
      const t0 = Date.now();
      try {
        await withTimeout(check, timeoutMs);
        return [name, { status: 'ok', durationMs: Date.now() - t0 }];
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return [name, { status: 'fail', durationMs: Date.now() - t0, error }];
      }
    }),
  );
  return Object.fromEntries(results);
}

/**
 * `GET /health`: liveness — il processo è vivo e risponde. Non interroga dipendenze.
 * `GET /ready`:  readiness — tutte le dipendenze (postgres, redis, …) rispondono; 503 altrimenti.
 */
export async function healthRoutes(app: FastifyInstance, opts: HealthRouteOptions): Promise<void> {
  const timeoutMs = opts.checkTimeoutMs ?? 2_000;

  app.get('/health', async () => ({
    status: 'ok',
    service: opts.service.name,
    version: opts.service.version,
    env: opts.env,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_req, reply) => {
    const checks = await runChecks(opts.checks, timeoutMs);
    const healthy = Object.values(checks).every((c) => c.status === 'ok');
    const body = {
      status: healthy ? 'ready' : 'not_ready',
      service: opts.service.name,
      version: opts.service.version,
      checks,
      timestamp: new Date().toISOString(),
    };
    return reply.code(healthy ? 200 : 503).send(body);
  });
}
