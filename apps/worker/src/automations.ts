import { readFile } from 'node:fs/promises';
import { createPgApprovalStore, type Memory } from '@ernie/agent-core';
import {
  AUTOMATION_QUEUE,
  automationBackoff,
  createAutomationQueue,
  createAutomationRepository,
  dedupeKeys,
  enqueueRun,
  executeRun,
  type GuidedDeps,
  jitterMs,
  notifyDeadLetter,
  PermanentError,
  previousOccurrence,
  type RunJobData,
  type RunnerDeps,
  syncSchedulers,
  type TickJobData,
} from '@ernie/automations';
import type { AppConfig } from '@ernie/config';
import type { Pool } from '@ernie/db';
import {
  createDecisionRouter,
  createHttpJevClient,
  createRedisDecisionCache,
  createRouterDecisionRecorder,
  DEFAULT_THRESHOLDS,
  Thresholds,
} from '@ernie/jev-router';
import type { MemoryRepository } from '@ernie/memory';
import { createBudgetGuard, type LlmCallRecorder, type ModelGateway } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import { createShoppingListSkill, SkillRegistry } from '@ernie/skills';
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
import { UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

export interface AutomationsContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly connection: Redis;
  readonly pool: Pool;
  readonly memories: MemoryRepository;
  readonly gateway: ModelGateway | null;
  readonly threads: Memory;
  readonly recorder: LlmCallRecorder;
}

async function loadThresholds(file: string, logger: Logger): Promise<Thresholds> {
  try {
    return Thresholds.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file },
      'soglie del router non caricate: uso i valori predefiniti',
    );
    return DEFAULT_THRESHOLDS;
  }
}

/**
 * Automation Engine sul worker: sincronizza i job scheduler con le automazioni abilitate, trasforma i
 * tick cron in run idempotenti (jitter, istante pianificato canonico) ed esegue le run senza client connesso.
 */
export async function startAutomations(
  ctx: AutomationsContext,
): Promise<{ close(): Promise<void> }> {
  const { config, logger, connection, pool } = ctx;
  const repo = createAutomationRepository(pool);
  const queue = createAutomationQueue(connection);

  // Lo stesso catalogo dell'API, senza il wrapper che pubblica eventi: una run non può innescarne altre.
  const shopping = createShoppingListRepository(pool);
  const registry = new ToolRegistry()
    .register(getTimeTool)
    .register(createMemorySearchSpec(ctx.memories));
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
  }
  const skills = new SkillRegistry().register(createShoppingListSkill(shopping));

  let guided: GuidedDeps | null = null;
  if (ctx.gateway) {
    const thresholds = await loadThresholds(config.router.thresholdsFile, logger);
    const jevClient = config.providers.openrouterApiKey
      ? createHttpJevClient({
          apiKey: config.providers.openrouterApiKey,
          model: config.router.jevModel,
        })
      : null;
    const router = createDecisionRouter({
      client: jevClient,
      cache: createRedisDecisionCache(connection),
      thresholds,
      timeoutMs: config.router.timeoutMs,
      cacheTtlSeconds: config.router.cacheTtlSeconds,
      logger,
    });
    guided = {
      gateway: ctx.gateway,
      memory: ctx.threads,
      souls: createSoulRepository(pool),
      memories: ctx.memories,
      registry,
      toolCategories: config.tools.categories,
      executor: {
        policyRules: { riskAskThreshold: config.tools.riskAskThreshold },
        audit: createToolCallRecorder(pool, logger),
        logger,
      },
      approvals: {
        store: createPgApprovalStore(pool),
        ttlMs: config.automations.approvalTtlSeconds * 1000,
      },
      recorder: ctx.recorder,
      budget: createBudgetGuard(pool),
      dailyBudgetUsd: config.llm.dailyBudgetUsd,
      router,
      decisions: createRouterDecisionRecorder(pool, logger),
      snapshotMaxChars: config.memory.snapshotMaxChars,
      retrievalLimit: config.memory.retrievalLimit,
    };
  } else {
    logger.warn(
      'nessun provider LLM: le automazioni guidate falliranno, quelle deterministiche girano',
    );
  }

  const runner: RunnerDeps = {
    pool,
    repo,
    logger,
    redis: connection,
    skillsFor: async () => skills,
    guided,
    catchUpToleranceSeconds: config.automations.catchUpToleranceSeconds,
  };

  const worker = new Worker(
    AUTOMATION_QUEUE,
    async (job) => {
      if (job.name === 'tick') {
        const d = job.data as TickJobData;
        const a = await repo.get(d.userId, d.automationId);
        if (!a?.enabled || a.trigger.type !== 'cron') return { ignored: true };
        const scheduledAt = previousOccurrence(a.trigger.pattern, a.timezone, new Date());
        return enqueueRun(
          queue,
          {
            automationId: a.id,
            userId: a.userId,
            scheduledAt: scheduledAt.toISOString(),
            dedupeKey: dedupeKeys.cron(scheduledAt),
            triggerType: 'cron',
            depth: 0,
          },
          jitterMs(a.jitterSeconds),
        );
      }
      if (job.name === 'run') {
        try {
          const run = await executeRun(runner, job.data as RunJobData, job.attemptsMade + 1);
          return run ? { runId: run.id, status: run.status } : { ignored: true };
        } catch (err) {
          if (err instanceof PermanentError) throw new UnrecoverableError(err.message);
          throw err;
        }
      }
      throw new UnrecoverableError(`job sconosciuto sulla coda ${AUTOMATION_QUEUE}: ${job.name}`);
    },
    {
      connection,
      concurrency: config.automations.concurrency,
      settings: {
        backoffStrategy: (attemptsMade: number, type?: string) =>
          type === 'automation' ? automationBackoff(attemptsMade) : 0,
      },
    },
  );
  worker.on('ready', () => logger.info({ queue: AUTOMATION_QUEUE }, 'worker automazioni pronto'));
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'job automazione fallito');
    // Dead-letter: retry transitori esauriti (gli errori definitivi sono già stati notificati dalla run).
    if (
      job?.name === 'run' &&
      err.name !== 'UnrecoverableError' &&
      job.attemptsMade >= (job.opts.attempts ?? 1)
    ) {
      void notifyDeadLetter(runner, job.data as RunJobData, err.message).catch((e: unknown) =>
        logger.warn({ err: e }, 'notifica dead-letter fallita'),
      );
    }
  });
  worker.on('error', (err) => logger.error({ err }, 'errore worker automazioni'));

  const sync = async () => {
    try {
      const enabled = await repo.listEnabledForScheduler();
      const r = await syncSchedulers(queue, enabled);
      logger.debug({ ...r, enabled: enabled.length }, 'scheduler delle automazioni sincronizzati');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'sincronizzazione scheduler fallita',
      );
    }
  };
  await sync();
  const timer = setInterval(() => void sync(), config.automations.syncEverySeconds * 1000);

  return {
    async close() {
      clearInterval(timer);
      await Promise.allSettled([worker.close(), queue.close()]);
    },
  };
}
