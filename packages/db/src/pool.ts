import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface CreatePoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

export function createPool(opts: CreatePoolOptions): Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'ernie',
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
  });
}

/** Verifica la raggiungibilità del database. Lancia un errore se non risponde. */
export async function checkDatabase(pool: Pool): Promise<{ serverVersion: string }> {
  const res = await pool.query<{ version: string }>('SELECT version() AS version');
  const version = res.rows[0]?.version ?? 'unknown';
  return { serverVersion: version };
}
