import { createConversationMemory, createMastraStorage } from '@ernie/agent-core';
import { loadConfig, redactConfig } from '@ernie/config';
import {
  buildProfiles,
  createBudgetGuard,
  createLlmCallRecorder,
  createModelGateway,
} from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import { createSoulRepository } from '@ernie/soul';
import { createAuthenticator } from './auth.js';
import { createCompanionFactory } from './companion.js';
import { createPostgres } from './infra/postgres.js';
import { createRedis } from './infra/redis.js';
import { buildServer } from './server.js';
import { createSessionStore } from './sessions/store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: config.service.name,
    pretty: config.env === 'development',
    base: { version: config.service.version, env: config.env },
  });
  logger.info({ config: redactConfig(config) }, 'avvio api');

  const postgres = createPostgres(config, logger);
  const redis = createRedis(config.redis.url, logger);

  const gateway = config.providers.openrouterApiKey
    ? createModelGateway({
        openrouterApiKey: config.providers.openrouterApiKey,
        profiles: buildProfiles(config.llm.models),
      })
    : null;
  if (!gateway)
    logger.warn(
      'OPENROUTER_API_KEY assente: i turni conversazionali risponderanno llm_unavailable',
    );

  const storage = createMastraStorage({ connectionString: config.db.url, disableInit: true });
  const memory = createConversationMemory(storage);
  const companions = createCompanionFactory({
    gateway,
    memory,
    souls: createSoulRepository(postgres.pool),
    logger,
  });
  const evict = setInterval(() => companions.cache.evictIdle(), 5 * 60_000);

  const app = await buildServer({
    config,
    logger,
    checks: { postgres: () => postgres.check(), redis: () => redis.check() },
    ws: {
      authenticator: createAuthenticator(postgres.pool),
      allowedOrigins: config.ws.allowedOrigins,
      connection: {
        logger,
        store: createSessionStore(postgres.pool, redis.client),
        recorder: createLlmCallRecorder(postgres.pool, logger),
        budget: createBudgetGuard(postgres.pool),
        dailyBudgetUsd: config.llm.dailyBudgetUsd,
        getCompanion: companions.getCompanion,
      },
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'arresto in corso');
    clearInterval(evict);
    const timer = setTimeout(() => {
      logger.error('arresto forzato dopo timeout');
      process.exit(1);
    }, 10_000);
    try {
      await app.close();
      await Promise.allSettled([postgres.close(), redis.close()]);
      clearTimeout(timer);
      logger.info('arresto completato');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "errore durante l'arresto");
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: il logger può non essere ancora inizializzato (es. config non valida)
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
