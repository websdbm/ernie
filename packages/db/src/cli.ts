import { loadConfig, redactConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import { migrationStatus, runMigrations } from './migrations.js';
import { createPool } from './pool.js';

/**
 * CLI: `node packages/db/dist/cli.js [up|status]`
 * Usata dal servizio `migrate` di docker-compose e da `pnpm migrate` in locale.
 */
async function main(): Promise<number> {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: 'ernie-migrate',
    pretty: config.env === 'development',
  });
  logger.debug({ config: redactConfig(config) }, 'configurazione caricata');

  const pool = createPool({
    connectionString: config.db.url,
    max: 2,
    applicationName: 'ernie-migrate',
  });
  const migLogger = {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(meta ?? {}, msg),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(meta ?? {}, msg),
  };

  try {
    switch (command) {
      case 'up': {
        const result = await runMigrations(pool, { logger: migLogger });
        logger.info(
          { applied: result.applied.map((m) => m.file), alreadyApplied: result.alreadyApplied },
          'migrazioni completate',
        );
        return 0;
      }
      case 'status': {
        const status = await migrationStatus(pool);
        logger.info(
          {
            applied: status.applied.map((a) => `${a.version}_${a.name}`),
            pending: status.pending.map((p) => p.file),
          },
          'stato migrazioni',
        );
        return status.pending.length === 0 ? 0 : 2;
      }
      default:
        logger.error({ command }, 'comando sconosciuto (usa: up | status)');
        return 64;
    }
  } catch (err) {
    logger.error({ err }, 'migrazione fallita');
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
