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

/**
 * Esegue `fn` in una transazione con `app.user_id` impostato (SET LOCAL): le policy RLS
 * filtrano ogni query sulle tabelle utente. Commit se `fn` risolve, rollback se rigetta.
 */
export async function withUser<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connessione già compromessa */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Abilita il LOGIN del ruolo applicativo con la password indicata (eseguito dal proprietario). */
export async function ensureAppRole(
  pool: Pool,
  password: string,
  role = 'ernie_app',
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`nome ruolo non valido: ${role}`);
  const client = await pool.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
    }
    await client.query(
      `ALTER ROLE "${role}" WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
  } finally {
    client.release();
  }
}
