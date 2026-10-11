import { createMastraStorage } from '@ernie/agent-core';
import { loadConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';

/**
 * Crea/aggiorna le tabelle mastra_* come proprietario del database (il ruolo applicativo non ha DDL).
 * Eseguito dal servizio `migrate` dopo le migrazioni SQL. I GRANT arrivano dai privilegi predefiniti (0004).
 */
async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    name: 'ernie-init-storage',
    pretty: config.env === 'development',
  });
  const storage = createMastraStorage({
    connectionString: config.db.migrationsUrl,
    disableInit: false,
    max: 2,
  });
  try {
    await storage.init();
    logger.info('storage Mastra inizializzato');
    return 0;
  } catch (err) {
    logger.error({ err }, 'inizializzazione storage Mastra fallita');
    return 1;
  } finally {
    await storage.close?.();
  }
}

process.exitCode = await main();
