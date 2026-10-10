import type { AppConfig } from '@ernie/config';
import { checkDatabase, createPool, type Pool } from '@ernie/db';
import type { Logger } from '@ernie/observability';

export interface PostgresResource {
  readonly pool: Pool;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgres(config: AppConfig, logger: Logger): PostgresResource {
  const pool = createPool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    applicationName: config.service.name,
  });
  pool.on('error', (err) => logger.error({ err }, 'errore sul pool postgres'));
  return {
    pool,
    async check() {
      await checkDatabase(pool);
    },
    async close() {
      await pool.end();
    },
  };
}
