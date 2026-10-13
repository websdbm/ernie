import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createConversationMemory,
  createMastraStorage,
  createPgApprovalStore,
  createReminderTitler,
  PendingApprovals,
} from '@ernie/agent-core';
import {
  createAutomationQueue,
  createAutomationRepository,
  createEventPublisher,
  offerProactive,
  publishUserEvent,
  subscribeUserEvents,
} from '@ernie/automations';
import { loadConfig, redactConfig } from '@ernie/config';
import { withUser } from '@ernie/db';
import {
  type ChunkHit,
  createChunkStore,
  createDocumentRepository,
  createSummarizer,
  verifiedCitations,
} from '@ernie/documents';
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
  createSessionSummaryStore,
  enqueueConsolidation,
  enqueueSessionSummary,
  recordTurnEpisode,
  renderSessionSummary,
} from '@ernie/memory';
import {
  buildProfiles,
  createBudgetGuard,
  createLlmCallRecorder,
  createModelGateway,
} from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import {
  createDiarySkill,
  createDocumentsSkill,
  createIntentSkill,
  createLearnedSkillRepository,
  createMemorySkill,
  createPgActivityStore,
  createRecipesSkill,
  createReminderSkill,
  createSentinelsSkill,
  createShoppingListSkill,
  tidyReminderText,
} from '@ernie/skills';
import { createSoulRepository } from '@ernie/soul';
import {
  createDocumentTools,
  createFirecrawlClient,
  createMemoryFocusStore,
  createMemorySearchSpec,
  createPgToolRuleStore,
  createRecipeRepository,
  createRecipeTools,
  createSentinelTools,
  createShoppingListRepository,
  createShoppingTools,
  createToolCallRecorder,
  createWebTools,
  getTimeTool,
  presentRecipesTool,
  ToolRegistry,
} from '@ernie/tools';
import { createAuthenticator } from './auth.js';
import { createCompanionFactory } from './companion.js';
import { createDocumentsFlow } from './documents-flow.js';
import { createFamilyRepository } from './family.js';
import { createPostgres } from './infra/postgres.js';
import { createRedis } from './infra/redis.js';
import { createIntentStore } from './intents.js';
import { createReminderStore } from './reminders.js';
import { createRouterDecisionRecorder } from './router/recorder.js';
import { createSentinelStore } from './sentinels.js';
import { buildServer } from './server.js';
import { createSessionStore } from './sessions/store.js';
import { ConnectionRegistry } from './ws/plugin.js';

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
  // Finestra caricata per turno; i messaggi oltre l'isteresi vengono riassunti (ricerca 11 C1).
  const memory = createConversationMemory(storage, { lastMessages: config.memory.historyMessages });
  const sessionSummaries = createSessionSummaryStore(postgres.pool);

  // Memory Engine: embeddings OpenAI (o finti senza chiave, solo full-text), coda di consolidamento sul worker.
  const embedder = config.providers.openaiApiKey
    ? createOpenAIEmbedder(config.providers.openaiApiKey, config.memory.embeddingModel)
    : createFakeEmbedder();
  if (!config.providers.openaiApiKey)
    logger.warn('OPENAI_API_KEY assente: memoria con embedder finto (solo full-text)');
  const memories = createMemoryRepository(postgres.pool, embedder, { logger });
  const memoryQueue = createMemoryQueue(redis.client);

  // Automation Engine (M6): definizioni e run nel database, coda BullMQ condivisa con il worker, eventi interni.
  const automationQueue = createAutomationQueue(redis.client);
  const automations = createAutomationRepository(postgres.pool);
  const events = createEventPublisher({ repo: automations, queue: automationQueue, logger });
  // Famiglia (M7e): collegamenti con etichetta fra installazioni; promemoria «a Giorgio».
  const family = createFamilyRepository(postgres.pool);
  const intents = createIntentStore(postgres.pool, family);
  // Promemoria («Ricordami»): automazioni una tantum accodate subito; a un familiare → nel suo account,
  // con scheda immediata nelle sue sessioni connesse (da lì partono notifica locale e widget).
  const reminders = createReminderStore({
    automations,
    queue: automationQueue,
    knownTools: [],
    maxBudgetUsd: config.automations.maxRunBudgetUsd,
    family,
    // Titolo breve dei promemoria con il modello leggero (ripiego deterministico senza provider).
    ...(gateway
      ? {
          title: createReminderTitler({
            gateway,
            recorder: createLlmCallRecorder(postgres.pool, logger),
            fallback: tidyReminderText,
          }),
        }
      : {}),
    notifyRecipient: (userId, block) =>
      publishUserEvent(redis.client, {
        userId,
        type: 'assistant.block',
        payload: { blockId: randomUUID(), block },
      }),
    proactive: (c) =>
      offerProactive({ pool: postgres.pool, repo: automations, redis: redis.client, logger }, c),
  });

  // Tool Registry: nucleo (orario, memoria) + lista della spesa + web (solo con chiave Firecrawl).
  // La chiusura della spesa pubblica `shopping_list.cleared` (solo dall'API: il worker non pubblica eventi).
  const shoppingBase = createShoppingListRepository(postgres.pool);
  const shopping: typeof shoppingBase = {
    ...shoppingBase,
    markAllBought: async (userId, listId) => {
      const n = await shoppingBase.markAllBought(userId, listId);
      if (n > 0)
        void events
          .publish(userId, 'shopping_list.cleared', { items: n })
          .catch((err: unknown) =>
            logger.warn({ err }, 'evento shopping_list.cleared non pubblicato'),
          );
      return n;
    },
  };
  const registry = new ToolRegistry()
    .register(getTimeTool)
    .register(presentRecipesTool)
    .register(createMemorySearchSpec(memories));
  for (const t of createShoppingTools(shopping)) registry.register(t);
  for (const t of createRecipeTools(createRecipeRepository(postgres.pool))) registry.register(t);
  // Documenti (M7b): testo estratto sul telefono; riassunto e schemi con il modello (classe standard/light), con registrazione dei costi.
  const documentsRepo = createDocumentRepository(postgres.pool);
  const summarizer = gateway
    ? createSummarizer({ gateway, recorder: createLlmCallRecorder(postgres.pool, logger), logger })
    : null;
  // Ricerca 11, S2: pezzi con pagina per cercare, citare e studiare per capitoli.
  const chunkStore = createChunkStore(postgres.pool, embedder);
  const documentFocus = createMemoryFocusStore();
  const turnPassages = new Map<string, { at: number; hits: ChunkHit[] }>();
  const rememberPassages = (requestId: string, hits: readonly ChunkHit[]) => {
    const now = Date.now();
    for (const [k, v] of turnPassages) if (now - v.at > 30 * 60_000) turnPassages.delete(k);
    const cur = turnPassages.get(requestId)?.hits ?? [];
    turnPassages.set(requestId, { at: now, hits: [...cur, ...hits] });
  };
  for (const t of createDocumentTools({
    repo: documentsRepo,
    summarizer,
    chunks: chunkStore,
    focus: documentFocus,
    onPassages: rememberPassages,
  }))
    registry.register(t);
  // Sentinelle (ricerca 11, C4 + C5): automazioni guidate con controllo economico e avviso a condizione.
  // knownTools è letto al momento della creazione: il web viene registrato più sotto.
  const sentinelStore = createSentinelStore({
    automations,
    get knownTools() {
      return registry.list().map((t) => t.id);
    },
    maxBudgetUsd: config.automations.maxRunBudgetUsd,
  });
  for (const t of createSentinelTools(sentinelStore)) registry.register(t);
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
  // «Consenti sempre» (M9): solo tool registrati e senza effetto esterno.
  const toolRules = createPgToolRuleStore(postgres.pool, {
    eligible: (toolId) => {
      const spec = registry.get(toolId);
      return spec !== undefined && !spec.risk.externalEffect;
    },
  });
  const executor = {
    policyRules: { riskAskThreshold: config.tools.riskAskThreshold },
    approvals: { ...approvals, ttlMs: config.tools.approvalTtlSeconds * 1000 },
    audit: createToolCallRecorder(postgres.pool, logger),
    rules: toolRules,
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
    sessionSummary: async (userId, sessionId) => {
      const s = await sessionSummaries.get(userId, sessionId);
      return s ? { text: renderSessionSummary(s), coveredUntil: s.coveredUntil } : null;
    },
    compaction:
      config.memory.compactMinChars > 0
        ? {
            minChars: config.memory.compactMinChars,
            historyBudgetChars: config.memory.compactBudgetChars,
          }
        : false,
    tools: {
      registry,
      executor,
      categories: config.tools.categories,
      core: ['memory_search', 'get_time', 'present_recipes'],
    },
    skills: {
      builtin: [
        createShoppingListSkill(shopping),
        createRecipesSkill(),
        createDocumentsSkill(),
        createSentinelsSkill(),
        // Promemoria a evento (ricerca 11, S1): fuori catalogo, viene prima di «Ricordami» nell'ordine.
        createIntentSkill(intents),
        createReminderSkill(reminders),
        createDiarySkill(createPgActivityStore(postgres.pool)),
        // «Cosa sai di me?», «perché sai che …?», «dimentica che …» (M9 A4): fuori catalogo, sempre attiva.
        createMemorySkill({
          search: (userId, query, limit) =>
            memories.search({ userId, query, kinds: ['semantic'], limit }),
          listActiveSemantic: (userId, limit) => memories.listActiveSemantic(userId, limit),
          forget: async (userId, id) => {
            const ok = await memories.forget(userId, id);
            // Lo snapshot della memoria sta nel prefisso dell'agente di sessione: va ricostruito.
            if (ok) companions.invalidateUser(userId);
            return ok;
          },
        }),
      ],
      learned: learnedSkills,
    },
    family,
    // Interruttori delle skill letti dal database a ogni invalidazione: valgono nella conversazione in corso.
    loadSettings: (userId) =>
      withUser(
        postgres.pool,
        userId,
        async (c) =>
          (
            await c.query<{ settings: Record<string, unknown> }>(
              `SELECT settings FROM users WHERE id = $1`,
              [userId],
            )
          ).rows[0]?.settings ?? {},
      ),
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

  // Eventi per utente dal worker (stato delle automazioni) → sessioni connesse in questo processo.
  const connections = new ConnectionRegistry();
  const subscriber = redis.client.duplicate();
  subscriber.on('error', (err) => logger.warn({ err: err.message }, 'errore subscriber redis'));
  await subscribeUserEvents(subscriber, (msg) => {
    void connections
      .push(msg.userId, msg.type, msg.payload)
      .catch((err: unknown) => logger.warn({ err }, 'recapito evento utente fallito'));
  });

  const authenticator = createAuthenticator(postgres.pool);
  const app = await buildServer({
    config,
    logger,
    checks: { postgres: () => postgres.check(), redis: () => redis.check() },
    automations: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      repo: automations,
      queue: automationQueue,
      events,
      knownTools: registry.list().map((t) => t.id),
      maxRunBudgetUsd: config.automations.maxRunBudgetUsd,
      approvals: { store: approvals.store, registry, audit: executor.audit },
      redis: redis.client,
      logger,
    },
    me: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      pool: postgres.pool,
      version: config.service.version,
    },
    skills: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      pool: postgres.pool,
      onChanged: (userId) => companions.invalidateUser(userId),
    },
    documents: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      repo: documentsRepo,
      onCreated: (userId, documentId, pages) => {
        void chunkStore
          .index(userId, documentId, pages)
          .catch((err: unknown) =>
            logger.warn({ err, documentId }, 'indicizzazione del documento fallita'),
          );
      },
    },
    shopping: { authenticator, allowedOrigins: config.ws.allowedOrigins, repo: shopping },
    reminders: { authenticator, allowedOrigins: config.ws.allowedOrigins, store: reminders },
    family: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      repo: family,
      onChanged: (userId) => companions.invalidateUser(userId),
    },
    toolRules: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      rules: toolRules,
      registry,
    },
    ws: {
      authenticator,
      allowedOrigins: config.ws.allowedOrigins,
      connections,
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
        approvals: { ...approvals, rules: toolRules },
        silentRuns: (userId) => automations.takeSilentRuns(userId, 3),
        // Scheda «Fonti»: pagine citate nella risposta e presenti tra i passaggi del turno.
        citations: (requestId, text) => {
          const hits = turnPassages.get(requestId)?.hits ?? [];
          turnPassages.delete(requestId);
          const items = verifiedCitations(text, hits);
          return items.length ? { kind: 'citations', title: 'Fonti', items } : null;
        },
        intents,
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
                // Il job controlla da sé la soglia: costa una lettura se non c'è niente da riassumere.
                await enqueueSessionSummary(memoryQueue, {
                  userId: info.userId,
                  sessionId: info.sessionId,
                });
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
        documents: {
          describe: (userId, id) => documentsRepo.describe(userId, id),
          flow: createDocumentsFlow({ repo: documentsRepo, summarizer }),
        },
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
      await Promise.allSettled([
        memoryQueue.close(),
        automationQueue.close(),
        subscriber.quit(),
        postgres.close(),
        redis.close(),
      ]);
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
