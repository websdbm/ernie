import { createHash } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';

export type ApprovalDecision = 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly args: unknown;
  readonly reason: string;
  readonly ttlMs: number;
}

export interface ApprovalStore {
  create(req: ApprovalRequest): Promise<{ id: string; expiresAt: Date; argsHash: string }>;
  /** Registra la decisione dell'utente; 'expired' se scaduta, 'not_found' se non esiste o non è pending. */
  resolve(
    userId: string,
    id: string,
    decision: 'approved' | 'denied',
  ): Promise<ApprovalDecision | 'not_found'>;
  /** Consuma atomicamente un'approvazione valida per (tool, argomenti): true una sola volta. */
  consume(userId: string, id: string, toolId: string, args: unknown): Promise<boolean>;
}

/** Hash stabile degli argomenti (chiavi ordinate): l'approvazione vale solo per questi argomenti. */
export function argsHash(args: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(args) ?? null))
    .digest('hex');
}

export function createPgApprovalStore(pool: Pool): ApprovalStore {
  return {
    async create(req) {
      const hash = argsHash(req.args);
      return withUser(pool, req.userId, async (client) => {
        const res = await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO tool_approvals (user_id, session_id, request_id, tool_call_id, tool_id, args_hash, reason, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8::int * interval '1 millisecond')) RETURNING id, expires_at`,
          [
            req.userId,
            req.sessionId,
            req.requestId,
            req.toolCallId,
            req.toolId,
            hash,
            req.reason,
            req.ttlMs,
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error('creazione approvazione fallita');
        return { id: row.id, expiresAt: row.expires_at, argsHash: hash };
      });
    },
    async resolve(userId, id, decision) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<{ status: string }>(
          `UPDATE tool_approvals
              SET status = CASE WHEN expires_at < now() THEN 'expired' ELSE $3 END, decided_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'pending'
            RETURNING status`,
          [id, userId, decision],
        );
        const row = res.rows[0];
        if (!row) return 'not_found';
        return row.status as ApprovalDecision;
      });
    },
    async consume(userId, id, toolId, args) {
      const hash = argsHash(args);
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE tool_approvals SET status = 'consumed', consumed_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'approved' AND expires_at > now() AND tool_id = $3 AND args_hash = $4`,
          [id, userId, toolId, hash],
        );
        return (res.rowCount ?? 0) === 1;
      });
    },
  };
}

/** Attese in memoria per le risposte dell'utente (una per processo; la verità resta nel database). */
export class PendingApprovals {
  private readonly waiters = new Map<string, (d: ApprovalDecision) => void>();

  wait(id: string, ttlMs: number, signal?: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const done = (d: ApprovalDecision) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(d);
      };
      const timer = setTimeout(() => done('expired'), ttlMs);
      signal?.addEventListener('abort', () => done('denied'), { once: true });
      this.waiters.set(id, done);
    });
  }

  settle(id: string, decision: ApprovalDecision): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    w(decision);
    return true;
  }

  get size(): number {
    return this.waiters.size;
  }
}
