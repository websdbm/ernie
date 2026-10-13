import { type Pool, withUser } from '@ernie/db';

/**
 * Regole «Consenti sempre» (M9): l'utente ha già detto sì a un tool, quindi la richiesta di conferma
 * (verdetto `ask`) diventa un consenso registrato. Non toccano mai un `deny` e non valgono per i tool con
 * effetto esterno (invii, messaggi): quelli chiedono sempre. Il controllo vive nell'executor, così vale
 * per chat, automazioni e ogni altra superficie.
 */
export interface ToolRule {
  readonly id: string;
  readonly toolId: string;
  readonly origin: 'card' | 'settings';
  readonly createdAt: Date;
}

export interface ToolRuleStore {
  list(userId: string): Promise<ToolRule[]>;
  /** Crea (o ritrova) la regola per un tool; null se il tool non è ammesso alle regole. */
  allow(userId: string, toolId: string, origin?: ToolRule['origin']): Promise<ToolRule | null>;
  /** Regola dal tool di un'approvazione appena decisa (scheda «Consenti sempre»). */
  allowFromApproval(userId: string, approvalId: string): Promise<ToolRule | null>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Con cache in memoria: l'executor lo chiama a ogni `ask`. */
  allows(userId: string, toolId: string): Promise<boolean>;
}

export interface ToolRuleStoreOptions {
  /** Tool ammessi alle regole: esistenti e senza effetto esterno (dal registry). */
  readonly eligible: (toolId: string) => boolean;
  readonly cacheTtlMs?: number;
}

interface Row {
  id: string;
  target: string;
  origin: ToolRule['origin'];
  created_at: Date;
}
const toRule = (r: Row): ToolRule => ({
  id: r.id,
  toolId: r.target,
  origin: r.origin,
  createdAt: r.created_at,
});

export function createPgToolRuleStore(pool: Pool, opts: ToolRuleStoreOptions): ToolRuleStore {
  const ttl = opts.cacheTtlMs ?? 60_000;
  const cache = new Map<string, { at: number; tools: Set<string> }>();
  const invalidate = (userId: string) => cache.delete(userId);

  const list = (userId: string) =>
    withUser(pool, userId, async (c) => {
      const res = await c.query<Row>(
        `SELECT id, target, origin, created_at FROM tool_rules WHERE scope = 'tool' ORDER BY created_at DESC`,
      );
      return res.rows.map(toRule);
    });

  const allow: ToolRuleStore['allow'] = async (userId, toolId, origin = 'settings') => {
    if (!opts.eligible(toolId)) return null;
    const rule = await withUser(pool, userId, async (c) => {
      const res = await c.query<Row>(
        `INSERT INTO tool_rules (user_id, scope, target, origin) VALUES ($1, 'tool', $2, $3)
         ON CONFLICT (user_id, scope, target) DO UPDATE SET target = EXCLUDED.target
         RETURNING id, target, origin, created_at`,
        [userId, toolId, origin],
      );
      return res.rows[0] ? toRule(res.rows[0]) : null;
    });
    invalidate(userId);
    return rule;
  };

  return {
    list,
    allow,
    async allowFromApproval(userId, approvalId) {
      const toolId = await withUser(pool, userId, async (c) => {
        const res = await c.query<{ tool_id: string }>(
          `SELECT tool_id FROM tool_approvals WHERE id = $1`,
          [approvalId],
        );
        return res.rows[0]?.tool_id ?? null;
      });
      return toolId ? allow(userId, toolId, 'card') : null;
    },
    async remove(userId, id) {
      const n = await withUser(pool, userId, async (c) => {
        const res = await c.query(`DELETE FROM tool_rules WHERE id = $1`, [id]);
        return res.rowCount ?? 0;
      });
      invalidate(userId);
      return n === 1;
    },
    async allows(userId, toolId) {
      const hit = cache.get(userId);
      if (hit && Date.now() - hit.at < ttl) return hit.tools.has(toolId);
      const tools = new Set((await list(userId)).map((r) => r.toolId));
      cache.set(userId, { at: Date.now(), tools });
      return tools.has(toolId);
    },
  };
}

/** Archivio in memoria per i test e per le CLI. */
export function memoryToolRuleStore(eligible: (toolId: string) => boolean = () => true) {
  const rows = new Map<string, Map<string, ToolRule>>();
  const of = (u: string) => rows.get(u) ?? rows.set(u, new Map()).get(u) ?? new Map();
  const store: ToolRuleStore = {
    async list(u) {
      return [...of(u).values()];
    },
    async allow(u, toolId, origin = 'settings') {
      if (!eligible(toolId)) return null;
      const m = of(u);
      const existing = [...m.values()].find((r) => r.toolId === toolId);
      if (existing) return existing;
      const r: ToolRule = { id: crypto.randomUUID(), toolId, origin, createdAt: new Date() };
      m.set(r.id, r);
      return r;
    },
    async allowFromApproval() {
      return null;
    },
    async remove(u, id) {
      return of(u).delete(id);
    },
    async allows(u, toolId) {
      return [...of(u).values()].some((r) => r.toolId === toolId);
    },
  };
  return store;
}
