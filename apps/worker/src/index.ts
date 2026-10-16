import { createConversationMemory, createMastraStorage } from '@ernie/agent-core';
import { loadConfig, redactConfig } from '@ernie/config';
import { createPool } from '@ernie/db';
import {
  consolidateThread,
  createFakeEmbedder,
  createLexiconStore,
  createLlmSummarizer,
  createMemoryRepository,
  createOpenAIEmbedder,
  createProfileStore,
  createSessionSummaryStore,
  ensurePurgeSchedule,
  MEMORY_QUEUE,
  summarizeSession,
} from '@ernie/memory';
import { buildProfiles, createLlmCallRecorder, createModelGateway } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { startAutomations } from './automations.js';
import { createSystemProcessor, HEARTBEAT_EVERY_MS, SYSTEM_QUEUE } from './processor.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: `${config.service.name}-worker`,
    pretty: config.env === 'development',
    base: { version: config.service.version, env: config.env },
  });
  logger.info({ config: redactConfig(config) }, 'avvio worker');

  // BullMQ richiede maxRetriesPerRequest: null sulle connessioni dei worker.
  const connection = new Redis(config.redis.url, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.warn({ err: err.message }, 'errore connessione redis'));

  const queue = new Queue(SYSTEM_QUEUE, { connection });
  await queue.upsertJobScheduler(
    'heartbeat',
    { every: HEARTBEAT_EVERY_MS },
    { name: 'heartbeat', opts: { removeOnComplete: 10, removeOnFail: 50 } },
  );

  const worker = new Worker(SYSTEM_QUEUE, createSystemProcessor({ store: connection, logger }), {
    connection,
    concurrency: 4,
  });

  // ---- Coda `memory`: consolidamento asincrono (modello light) e purge giornaliero ----
  const pool = createPool({
    connectionString: config.db.url,
    max: 3,
    applicationName: 'ernie-worker',
  });
  const ownerPool = createPool({
    connectionString: config.db.migrationsUrl,
    max: 1,
    applicationName: 'ernie-worker-owner',
  });
  const embedder = config.providers.openaiApiKey
    ? createOpenAIEmbedder(config.providers.openaiApiKey, config.memory.embeddingModel)
    : createFakeEmbedder();
  const repo = createMemoryRepository(pool, embedder, { logger });
  const gateway =
    config.providers.openrouterApiKey || config.providers.anthropicApiKey
      ? createModelGateway({
          ...(config.providers.openrouterApiKey
            ? { openrouterApiKey: config.providers.openrouterApiKey }
            : {}),
          ...(config.providers.anthropicApiKey
            ? { anthropicApiKey: config.providers.anthropicApiKey }
            : {}),
          profiles: buildProfiles(config.llm.models),
          onFallback: (info) =>
            logger.warn(info, 'API di Anthropic non disponibile: ripiego su OpenRouter'),
        })
      : null;
  const threads = createConversationMemory(
    createMastraStorage({ connectionString: config.db.url, disableInit: true, max: 2 }),
  );
  const recorder = createLlmCallRecorder(pool, logger);
  const sessionSummaries = createSessionSummaryStore(pool);
  const memoryQueue = new Queue(MEMORY_QUEUE, { connection });
  await ensurePurgeSchedule(memoryQueue, config.memory.retentionDays);
  const memoryWorker = new Worker(
    MEMORY_QUEUE,
    async (job) => {
      if (job.name === 'purge') {
        const n = await repo.purge(
          ownerPool,
          (job.data as { retentionDays: number }).retentionDays,
        );
        logger.info({ purged: n }, 'purge memorie');
        return { purged: n };
      }
      if (job.name === 'consolidate') {
        if (!gateway) {
          logger.warn('consolidamento saltato: nessun provider LLM');
          return { skipped: true };
        }
        const data = job.data as { userId: string; threadId: string; sessionId: string };
        return consolidateThread(
          {
            pool,
            repo,
            threads,
            gateway,
            recorder,
            logger,
            profiles: createProfileStore(pool),
            lexicon: createLexiconStore(pool),
          },
          data,
        );
      }
      if (job.name === 'summarize') {
        // Riassunto della conversazione (ricerca 11 C1): senza modello ripiega su un riassunto deterministico.
        const data = job.data as { userId: string; sessionId: string };
        return summarizeSession(
          {
            threads,
            store: sessionSummaries,
            logger,
            high: config.memory.summaryHigh,
            low: config.memory.summaryLow,
            ...(gateway
              ? {
                  summarizer: createLlmSummarizer(
                    { gateway, recorder },
                    data.userId,
                    data.sessionId,
                  ),
                }
              : {}),
          },
          data,
        );
      }
      throw new Error(`job sconosciuto sulla coda ${MEMORY_QUEUE}: ${job.name}`);
    },
    { connection, concurrency: 2 },
  );
  memoryWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err }, 'job memoria fallito'),
  );
  memoryWorker.on('ready', () => logger.info({ queue: MEMORY_QUEUE }, 'worker memoria pronto'));

  // ---- Coda `automations` (M6): scheduler sincronizzati con il database, run idempotenti senza client ----
  const automations = await startAutomations({
    config,
    logger,
    connection,
    pool,
    memories: repo,
    gateway,
    threads,
    recorder,
  });
  worker.on('ready', () => logger.info({ queue: SYSTEM_QUEUE }, 'worker pronto'));
  worker.on('completed', (job) =>
    logger.debug({ jobId: job.id, name: job.name }, 'job completato'),
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err }, 'job fallito'),
  );
  worker.on('error', (err) => logger.error({ err }, 'errore worker'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'arresto worker in corso');
    const timer = setTimeout(() => process.exit(1), 15_000);
    try {
      await Promise.allSettled([
        automations.close(),
        worker.close(),
        memoryWorker.close(),
        queue.close(),
        memoryQueue.close(),
      ]);
      await Promise.allSettled([pool.end(), ownerPool.end()]);
      await connection.quit();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "errore durante l'arresto");
      process.exit(1);
    }
  };
  // Una promessa rifiutata e non gestita non deve chiudere il processo (Node 24 lo farebbe): si registra.
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'promessa rifiutata non gestita');
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: il logger può non essere ancora inizializzato (es. config non valida)
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
