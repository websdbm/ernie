import { type Pool, withUser } from '@ernie/db';

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `budget giornaliero superato: spesi ${spentUsd.toFixed(4)} USD su ${budgetUsd.toFixed(2)} USD`,
    );
  }
}

export interface BudgetGuard {
  /** Lancia BudgetExceededError se la spesa odierna dell'utente ha raggiunto il tetto. */
  assertWithinBudget(userId: string, budgetUsd: number): Promise<{ spentUsd: number }>;
}

/**
 * Spesa odierna dal registro persistente, inclusi Jev e chiamate poi eliminate. Il giorno è quello di Roma, come nel
 * pannello consumi (default Europe/Rome): il tetto si azzera alla mezzanotte italiana, non all'1 o alle 2.
 */
export function createBudgetGuard(pool: Pool): BudgetGuard {
  return {
    async assertWithinBudget(userId, budgetUsd) {
      const res = await withUser(pool, userId, (client) =>
        client.query<{ spent: string | null }>(
          `SELECT COALESCE(SUM(COALESCE(reported_usd, estimated_usd)), 0)::text AS spent
             FROM usage_ledger
            WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'`,
          [userId],
        ),
      );
      const spentUsd = Number(res.rows[0]?.spent ?? 0);
      if (budgetUsd > 0 && spentUsd >= budgetUsd)
        throw new BudgetExceededError(spentUsd, budgetUsd);
      return { spentUsd };
    },
  };
}

/** Le pipeline a più chiamate rileggono impostazioni e spesa prima di ogni richiesta pagata. */
export function createUserBudgetCheck(pool: Pool, defaultLimit: number) {
  const guard = createBudgetGuard(pool);
  return async (userId: string): Promise<void> => {
    const user = await withUser(
      pool,
      userId,
      async (c) =>
        (
          await c.query<{ role: string; settings: Record<string, unknown> }>(
            'SELECT role, settings FROM users WHERE id = $1',
            [userId],
          )
        ).rows[0],
    );
    if (!user) throw new Error('utente non disponibile');
    if (user.settings.killSwitch === true) throw new Error('Ernie è in pausa');
    const own = user.settings.dailyBudgetUsd;
    const limit =
      user.role === 'owner' && typeof own === 'number'
        ? own
        : typeof own === 'number' && own > 0
          ? Math.min(own, defaultLimit || own)
          : defaultLimit;
    await guard.assertWithinBudget(userId, limit);
  };
}
