import { loadConfig, redactConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
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
      await worker.close();
      await queue.close();
      await connection.quit();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "errore durante l'arresto");
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: il logger può non essere ancora inizializzato (es. config non valida)
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
