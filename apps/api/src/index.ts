import { readFile } from 'node:fs/promises';
import {
  createConversationMemory,
  createMastraStorage,
  createPgApprovalStore,
  PendingApprovals,
} from '@ernie/agent-core';
import { loadConfig, redactConfig } from '@ernie/config';
import {
  createDecisionRouter,
  createHttpJevClient,
  createRedisDecisionCache,
  DEFAULT_THRESHOLDS,
  Thresholds,
} from '@ernie/jev-router';
import {
  createFakeEmbedder,
  createMemoryQueue,
  createMemoryRepository,
  createOpenAIEmbedder,
  enqueueConsolidation,
  recordTurnEpisode,
} from '@ernie/memory';
import {
  buildProfiles,
  createBudgetGuard,
  createLlmCallRecorder,
  createModelGateway,
} from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import { createLearnedSkillRepository, createShoppingListSkill } from '@ernie/skills';
import { createSoulRepository } from '@ernie/soul';
import {
  createFirecrawlClient,
  createMemorySearchSpec,
  createShoppingListRepository,
  createShoppingTools,
  createToolCallRecorder,
  createWebTools,
  getTimeTool,
  ToolRegistry,
} from '@ernie/tools';
import { createAuthenticator } from './auth.js';
import { createCompanionFactory } from './companion.js';
import { createPostgres } from './infra/postgres.js';
import { createRedis } from './infra/redis.js';
import { createRouterDecisionRecorder } from './router/recorder.js';
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
  if (config.env === 'production' && /:(ernie|ernie_app)@/.test(config.db.url)) {
    logger.warn(
      'DATABASE_URL usa la password di sviluppo predefinita: in produzione va cambiata (APP_DB_PASSWORD, POSTGRES_PASSWORD)',
    );
  }

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

  // Memory Engine: embeddings OpenAI (o finti senza chiave, solo full-text), coda di consolidamento sul worker.
  const embedder = config.providers.openaiApiKey
    ? createOpenAIEmbedder(config.providers.openaiApiKey, config.memory.embeddingModel)
    : createFakeEmbedder();
  if (!config.providers.openaiApiKey)
    logger.warn('OPENAI_API_KEY assente: memoria con embedder finto (solo full-text)');
  const memories = createMemoryRepository(postgres.pool, embedder, { logger });
  const memoryQueue = createMemoryQueue(redis.client);

  // Tool Registry: nucleo (orario, memoria) + lista della spesa + web (solo con chiave Firecrawl).
  const shopping = createShoppingListRepository(postgres.pool);
  const registry = new ToolRegistry()
    .register(getTimeTool)
    .register(createMemorySearchSpec(memories));
  for (const t of createShoppingTools(shopping)) registry.register(t);
  if (config.providers.firecrawlApiKey) {
    const web = createWebTools(
      createFirecrawlClient({ apiKey: config.providers.firecrawlApiKey }),
      {
        allowedDomains: config.tools.webAllowedDomains,
        blockedDomains: config.tools.webBlockedDomains,
        maxResults: 5,
        maxCharsPerResult: 3_000,
      },
    );
    for (const t of web) registry.register(t);
  } else {
    logger.warn('FIRECRAWL_API_KEY assente: tool web non registrati');
  }
  const approvals = {
    store: createPgApprovalStore(postgres.pool),
    pending: new PendingApprovals(),
  };
  const executor = {
    policyRules: { riskAskThreshold: config.tools.riskAskThreshold },
    approvals: { ...approvals, ttlMs: config.tools.approvalTtlSeconds * 1000 },
    audit: createToolCallRecorder(postgres.pool, logger),
    logger,
  };
  const learnedSkills = createLearnedSkillRepository(postgres.pool, registry);

  const companions = createCompanionFactory({
    gateway,
    memory,
    souls: createSoulRepository(postgres.pool),
    logger,
    memories,
    snapshotMaxChars: config.memory.snapshotMaxChars,
    tools: {
      registry,
      executor,
      categories: config.tools.categories,
      core: ['memory_search', 'get_time'],
    },
    skills: { builtin: [createShoppingListSkill(shopping)], learned: learnedSkills },
  });
  const evict = setInterval(() => companions.cache.evictIdle(), 5 * 60_000);
  logger.info(
    { tools: registry.list().map((t) => t.id), categories: config.tools.categories },
    'registry dei tool',
  );

  // Router JEV: soglie da file (calibrate su dati etichettati), cache esatta su Redis, fallback deterministico.
  let thresholds = DEFAULT_THRESHOLDS;
  try {
    thresholds = Thresholds.parse(JSON.parse(await readFile(config.router.thresholdsFile, 'utf8')));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file: config.router.thresholdsFile },
      'soglie del router non caricate: uso i valori predefiniti',
    );
  }
  const jevClient = config.providers.openrouterApiKey
    ? createHttpJevClient({
        apiKey: config.providers.openrouterApiKey,
        model: config.router.jevModel,
      })
    : null;
  if (!jevClient) logger.warn('router Jev non configurato: decisioni di fallback');
  const router = createDecisionRouter({
    client: jevClient,
    cache: createRedisDecisionCache(redis.client),
    thresholds,
    timeoutMs: config.router.timeoutMs,
    cacheTtlSeconds: config.router.cacheTtlSeconds,
    logger,
  });

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
        invalidateCompanion: (sessionId) => companions.invalidate(sessionId),
        router,
        decisions: createRouterDecisionRecorder(postgres.pool, logger),
        approvals,
        memories: {
          repo: memories,
          retrievalLimit: config.memory.retrievalLimit,
          afterTurn: async (info) => {
            try {
              await recordTurnEpisode(memories, info);
              if (info.outcome === 'completed' && info.llmCalls > 0) {
                await enqueueConsolidation(
                  memoryQueue,
                  { userId: info.userId, threadId: info.sessionId, sessionId: info.sessionId },
                  config.memory.consolidationDelaySeconds * 1000,
                );
              }
            } catch (err) {
              logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'post-turno memoria fallito',
              );
            }
          },
        },
        tools: {
          categories: config.tools.categories,
          setToolContext: companions.setToolContext,
          taintTtlSeconds: 1800,
        },
        skills: { registryFor: companions.skillsFor },
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
      await Promise.allSettled([memoryQueue.close(), postgres.close(), redis.close()]);
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
