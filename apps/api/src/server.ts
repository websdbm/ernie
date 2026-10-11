import type { AppConfig } from '@ernie/config';
import { type Logger, newId } from '@ernie/observability';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { type HealthCheck, healthRoutes } from './routes/health.js';
import { registerWs, type WsPluginOptions } from './ws/plugin.js';

export interface BuildServerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Controlli di readiness per nome (es. postgres, redis). */
  readonly checks: Readonly<Record<string, HealthCheck>>;
  /** Endpoint WebSocket del protocollo v1 (assente nei test di sola salute). */
  readonly ws?: WsPluginOptions;
}

interface HttpErrorLike {
  statusCode?: unknown;
  code?: unknown;
}

function describeError(err: unknown): { statusCode: number; code: string; message: string } {
  const e: HttpErrorLike = typeof err === 'object' && err !== null ? (err as HttpErrorLike) : {};
  const statusCode =
    typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode <= 599
      ? e.statusCode
      : 500;
  const code = typeof e.code === 'string' && e.code !== '' ? e.code : 'request_error';
  const message = err instanceof Error ? err.message : String(err);
  return { statusCode, code, message };
}

/**
 * Costruisce l'istanza Fastify senza avviarla: usata sia dal bootstrap (index.ts)
 * sia dai test tramite `app.inject()`.
 */
export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  // pino.Logger è strutturalmente compatibile con FastifyBaseLogger; l'annotazione
  // esplicita evita di propagare il tipo concreto di pino nei generics di Fastify.
  const loggerInstance: FastifyBaseLogger = opts.logger;

  const app = Fastify({
    loggerInstance,
    requestIdHeader: 'x-request-id',
    genReqId: () => newId(),
    trustProxy: true,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const { statusCode, code, message } = describeError(err);
    if (statusCode >= 500) req.log.error({ err }, 'errore non gestito');
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : code,
      message: statusCode >= 500 ? 'Errore interno' : message,
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'Risorsa non trovata', requestId: req.id });
  });

  await app.register(healthRoutes, {
    service: opts.config.service,
    env: opts.config.env,
    checks: opts.checks,
  });

  if (opts.ws) await registerWs(app, opts.ws);

  return app;
}

export type AppServer = Awaited<ReturnType<typeof buildServer>>;
