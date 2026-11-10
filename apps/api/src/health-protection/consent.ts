import { type Pool, type PoolClient, withUser } from '@ernie/db';

export const HEALTH_AI_POLICY_VERSION = 1;
export const HEALTH_AI_CONSENT_TEXT =
  'Autorizzo Ernie a inviare i dati pertinenti della sezione Salute al modello AI configurato per analisi e riepiloghi. Posso revocare il consenso in qualsiasi momento. La revoca blocca nuove elaborazioni e scarta i risultati ancora in corso; non può ritirare dati già inviati al fornitore. La consultazione e l’esportazione manuale restano disponibili. Il diario personale è escluso.';

export interface HealthConsentState {
  revision: number;
  aiAllowed: boolean;
  policyVersion: number;
  grantedAt: string | null;
  revokedAt: string | null;
}

export class HealthConsentError extends Error {
  override readonly name = 'HealthConsentError';
  constructor(readonly code: 'health_consent_required' | 'health_consent_changed') {
    super(
      code === 'health_consent_changed'
        ? 'Le autorizzazioni Salute sono cambiate. Riapri la sezione prima di proseguire.'
        : 'Per questa elaborazione attiva Salute e autorizza l’analisi AI nella sezione Salute.',
    );
  }
}

export interface HealthConsentTicket {
  readonly userId: string;
  readonly revision: number;
  readonly policyVersion: number;
  readonly expiresAt: number;
}

type Row = {
  revision: number;
  ai_allowed: boolean;
  policy_version: number;
  granted_at: Date | null;
  revoked_at: Date | null;
};
const state = (r: Row): HealthConsentState => ({
  revision: r.revision,
  aiAllowed: r.ai_allowed && r.policy_version === HEALTH_AI_POLICY_VERSION,
  policyVersion: r.policy_version,
  grantedAt: r.granted_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

/** Authorization is durable, account-scoped and separate from both skill availability and storage.
 * Tickets are server-created capabilities for one operation; regranting never revives an old ticket.
 * Every AI boundary must check a ticket, and every result write must use guardWrite in its transaction.
 */
export function createHealthConsentStore(
  pool: Pool,
  isEnabled: (userId: string, client: PoolClient) => Promise<boolean>,
  options: { now?: () => number; pollMs?: number; lifetimeMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const pollMs = Math.max(50, options.pollMs ?? 1_000);
  const lifetimeMs = Math.min(30 * 60_000, Math.max(1_000, options.lifetimeMs ?? 10 * 60_000));
  const tickets = new WeakSet<HealthConsentTicket>();
  const active = new Map<string, Set<AbortController>>();

  const getRow = async (client: PoolClient, userId: string, lock = ''): Promise<Row> => {
    await client.query('INSERT INTO health_privacy(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      userId,
    ]);
    const result = await client.query<Row>(
      `SELECT revision,ai_allowed,policy_version,granted_at,revoked_at FROM health_privacy WHERE user_id=$1 ${lock}`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new HealthConsentError('health_consent_required');
    return row;
  };

  const assertTicket = (ticket: HealthConsentTicket, userId: string) => {
    if (!tickets.has(ticket) || ticket.userId !== userId || now() >= ticket.expiresAt)
      throw new HealthConsentError('health_consent_changed');
  };

  const guardWrite = async (ticket: HealthConsentTicket, userId: string, client: PoolClient) => {
    assertTicket(ticket, userId);
    // The checker uses this same transaction: no nested pool acquisition while holding a slot.
    await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [userId]);
    if (!(await isEnabled(userId, client))) throw new HealthConsentError('health_consent_required');
    // Held to transaction end: revocation cannot commit between authorization and result persistence.
    const row = await getRow(client, userId, 'FOR SHARE');
    if (!row.ai_allowed || row.policy_version !== HEALTH_AI_POLICY_VERSION)
      throw new HealthConsentError('health_consent_required');
    if (row.revision !== ticket.revision || row.policy_version !== ticket.policyVersion)
      throw new HealthConsentError('health_consent_changed');
    // A slow permission check or database lock may have consumed the remaining lease.
    assertTicket(ticket, userId);
  };

  const check = (ticket: HealthConsentTicket) =>
    withUser(pool, ticket.userId, (c) => guardWrite(ticket, ticket.userId, c));

  const stopLocal = (userId: string) => {
    for (const controller of active.get(userId) ?? []) controller.abort();
  };

  return {
    async get(userId: string): Promise<HealthConsentState> {
      return withUser(pool, userId, async (c) => state(await getRow(c, userId)));
    },
    async grant(
      userId: string,
      expectedRevision: number,
      policyVersion: number,
    ): Promise<HealthConsentState> {
      if (policyVersion !== HEALTH_AI_POLICY_VERSION || !Number.isSafeInteger(expectedRevision))
        throw new HealthConsentError('health_consent_changed');
      return withUser(pool, userId, async (c) => {
        await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [userId]);
        if (!(await isEnabled(userId, c))) throw new HealthConsentError('health_consent_required');
        const row = await getRow(c, userId, 'FOR UPDATE');
        if (row.revision !== expectedRevision)
          throw new HealthConsentError('health_consent_changed');
        const updated = await c.query<Row>(
          `UPDATE health_privacy SET ai_allowed=true,policy_version=$2,revision=revision+1,
           granted_at=now(),updated_at=now() WHERE user_id=$1 RETURNING *`,
          [userId, HEALTH_AI_POLICY_VERSION],
        );
        await c.query(
          `INSERT INTO health_consent_events(user_id,revision,action,policy_version) VALUES ($1,$2,'grant',$3)`,
          [userId, updated.rows[0]?.revision, HEALTH_AI_POLICY_VERSION],
        );
        return state(updated.rows[0] as Row);
      });
    },
    async revoke(userId: string): Promise<HealthConsentState> {
      // Revocation deliberately needs no expectedRevision: a stale device can always stop access.
      stopLocal(userId);
      const result = await withUser(pool, userId, async (c) => {
        await getRow(c, userId, 'FOR UPDATE');
        const updated = await c.query<Row>(
          `UPDATE health_privacy SET ai_allowed=false,revision=revision+1,
           revoked_at=now(),updated_at=now() WHERE user_id=$1 RETURNING *`,
          [userId],
        );
        await c.query(
          `INSERT INTO health_consent_events(user_id,revision,action,policy_version) VALUES ($1,$2,'revoke',$3)`,
          [userId, updated.rows[0]?.revision, updated.rows[0]?.policy_version],
        );
        return state(updated.rows[0] as Row);
      });
      stopLocal(userId);
      return result;
    },
    async acquire(userId: string, expectedRevision?: number): Promise<HealthConsentTicket> {
      const row = await withUser(pool, userId, async (c) => {
        await c.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [userId]);
        if (!(await isEnabled(userId, c))) throw new HealthConsentError('health_consent_required');
        return getRow(c, userId);
      });
      if (!row.ai_allowed || row.policy_version !== HEALTH_AI_POLICY_VERSION)
        throw new HealthConsentError('health_consent_required');
      if (expectedRevision !== undefined && expectedRevision !== row.revision)
        throw new HealthConsentError('health_consent_changed');
      const ticket = Object.freeze({
        userId,
        revision: row.revision,
        policyVersion: row.policy_version,
        expiresAt: now() + lifetimeMs,
      });
      tickets.add(ticket);
      return ticket;
    },
    check,
    guardWrite,
    async run<T>(
      ticket: HealthConsentTicket,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      await check(ticket);
      const controller = new AbortController();
      const operations = active.get(ticket.userId) ?? new Set<AbortController>();
      operations.add(controller);
      active.set(ticket.userId, operations);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const poll = async () => {
        try {
          await check(ticket);
        } catch {
          controller.abort();
        }
        if (!finished && !controller.signal.aborted) timer = setTimeout(poll, pollMs);
      };
      timer = setTimeout(poll, pollMs);
      try {
        // Covers a revocation racing acquisition/registration of the local abort controller.
        await check(ticket);
        if (controller.signal.aborted) throw new HealthConsentError('health_consent_changed');
        const result = await work(controller.signal);
        await check(ticket);
        if (controller.signal.aborted) throw new HealthConsentError('health_consent_changed');
        return result;
      } finally {
        finished = true;
        clearTimeout(timer);
        operations.delete(controller);
        if (operations.size === 0) active.delete(ticket.userId);
      }
    },
  };
}

export type HealthConsentStore = ReturnType<typeof createHealthConsentStore>;
