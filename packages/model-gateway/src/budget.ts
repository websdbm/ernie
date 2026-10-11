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

/** Spesa odierna (UTC) = somma del costo riportato, o stimato dove manca. Deterministico, nessun LLM. */
export function createBudgetGuard(pool: Pool): BudgetGuard {
  return {
    async assertWithinBudget(userId, budgetUsd) {
      const res = await withUser(pool, userId, (client) =>
        client.query<{ spent: string | null }>(
          `SELECT COALESCE(SUM(COALESCE(cost_reported_usd, cost_estimated_usd)), 0)::text AS spent
             FROM llm_calls
            WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
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
