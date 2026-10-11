import { randomBytes } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';
import { validateTrigger } from './schedule.js';
import {
  type Action,
  type Automation,
  AutomationInput,
  type AutomationRun,
  type Notification,
  type RunOutcome,
  type RunStatus,
  type Trigger,
} from './schema.js';

export class AutomationValidationError extends Error {
  override readonly name = 'AutomationValidationError';
}

interface ARow {
  id: string;
  user_id: string;
  key: string;
  title: string;
  kind: Automation['kind'];
  trigger: Trigger;
  timezone: string;
  action: Action;
  budget_usd: string;
  catch_up: Automation['catchUp'];
  jitter_s: number;
  notify: boolean;
  enabled: boolean;
  version: number;
  meta: Record<string, unknown> | null;
  webhook_secret: string | null;
  created_at: Date;
  updated_at: Date;
}
interface RRow {
  id: string;
  automation_id: string;
  user_id: string;
  scheduled_at: Date;
  dedupe_key: string;
  trigger_type: string;
  trigger_payload: unknown;
  status: RunStatus;
  outcome: RunOutcome | null;
  error: string | null;
  cost_usd: string;
  llm_calls: number;
  tool_calls: number;
  attempt: number;
  session_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}
interface NRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  payload: unknown;
  read_at: Date | null;
  created_at: Date;
}

const A_COLS = `id, user_id, key, title, kind, trigger, timezone, action, budget_usd, catch_up, jitter_s, notify, enabled, version, meta, webhook_secret, created_at, updated_at`;
const R_COLS = `id, automation_id, user_id, scheduled_at, dedupe_key, trigger_type, trigger_payload, status, outcome, error, cost_usd, llm_calls, tool_calls, attempt, session_id, started_at, finished_at, created_at`;
const N_COLS = `id, user_id, kind, title, body, payload, read_at, created_at`;

const toAutomation = (r: ARow): Automation => ({
  id: r.id,
  userId: r.user_id,
  key: r.key,
  title: r.title,
  kind: r.kind,
  trigger: r.trigger,
  timezone: r.timezone,
  action: r.action,
  budgetUsd: Number(r.budget_usd),
  catchUp: r.catch_up,
  jitterSeconds: r.jitter_s,
  notify: r.notify,
  enabled: r.enabled,
  version: r.version,
  meta: r.meta ?? {},
  webhookSecret: r.webhook_secret,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toRun = (r: RRow): AutomationRun => ({
  id: r.id,
  automationId: r.automation_id,
  userId: r.user_id,
  scheduledAt: r.scheduled_at,
  dedupeKey: r.dedupe_key,
  triggerType: r.trigger_type,
  triggerPayload: r.trigger_payload,
  status: r.status,
  outcome: r.outcome,
  error: r.error,
  costUsd: Number(r.cost_usd),
  llmCalls: r.llm_calls,
  toolCalls: r.tool_calls,
  attempt: r.attempt,
  sessionId: r.session_id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
});
const toNotification = (r: NRow): Notification => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  payload: r.payload,
  readAt: r.read_at,
  createdAt: r.created_at,
});

export interface ClaimInput {
  readonly userId: string;
  readonly automationId: string;
  readonly scheduledAt: Date;
  readonly dedupeKey: string;
  readonly triggerType: string;
  readonly payload?: unknown;
  readonly attempt: number;
}

export interface RunFinish {
  readonly status: Exclude<RunStatus, 'scheduled' | 'claimed' | 'running'>;
  readonly outcome?: RunOutcome | null;
  readonly error?: string | null;
  readonly costUsd?: number;
  readonly llmCalls?: number;
  readonly toolCalls?: number;
  readonly sessionId?: string | null;
}

export interface CreateOptions {
  /** Tool noti al registry: un'azione guidata con tool sconosciuti viene rifiutata. */
  readonly knownTools?: readonly string[];
  readonly maxBudgetUsd?: number;
}

export interface AutomationRepository {
  create(userId: string, input: unknown, opts?: CreateOptions): Promise<Automation>;
  setEnabled(userId: string, id: string, enabled: boolean): Promise<Automation | null>;
  remove(userId: string, id: string): Promise<boolean>;
  get(userId: string, id: string): Promise<Automation | null>;
  list(userId: string): Promise<Automation[]>;
  listByEvent(userId: string, eventName: string): Promise<Automation[]>;
  /** Tutte le automazioni abilitate, di tutti gli utenti: solo per la sincronizzazione degli scheduler (policy dedicata). */
  listEnabledForScheduler(): Promise<Automation[]>;
  /** Dati minimi per verificare la firma di un webhook (funzione SECURITY DEFINER, nessun utente autenticato). */
  webhookTarget(
    automationId: string,
  ): Promise<{ userId: string; secret: string | null; enabled: boolean } | null>;
  /** Reclama la run: null se la chiave di idempotenza esiste già e non è un retry legittimo. */
  claimRun(input: ClaimInput): Promise<AutomationRun | null>;
  finishRun(userId: string, runId: string, f: RunFinish): Promise<AutomationRun | null>;
  updateRunOutcome(
    userId: string,
    runId: string,
    outcome: RunOutcome,
    status?: RunStatus,
  ): Promise<AutomationRun | null>;
  getRun(userId: string, runId: string): Promise<AutomationRun | null>;
  listRuns(userId: string, automationId: string, limit?: number): Promise<AutomationRun[]>;
  listRecentRuns(userId: string, limit?: number): Promise<AutomationRun[]>;
  findRunByApproval(userId: string, approvalId: string): Promise<AutomationRun | null>;
  spentTodayUsd(userId: string, automationId: string): Promise<number>;
  /** `users.settings` dell'utente (interruttore di emergenza, budget personale). */
  getUserSettings(userId: string): Promise<Record<string, unknown>>;
  notify(
    userId: string,
    n: { kind: string; title: string; body: string; payload?: unknown },
  ): Promise<Notification>;
  listNotifications(userId: string, unreadOnly?: boolean, limit?: number): Promise<Notification[]>;
  markRead(userId: string, ids: readonly string[]): Promise<number>;
}

export function createAutomationRepository(pool: Pool): AutomationRepository {
  return {
    async create(userId, input, opts = {}) {
      const parsed = AutomationInput.safeParse(input);
      if (!parsed.success)
        throw new AutomationValidationError(
          parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        );
      const a = parsed.data;
      validateTrigger(a.trigger, a.timezone);
      if (opts.maxBudgetUsd !== undefined && a.budgetUsd > opts.maxBudgetUsd)
        throw new AutomationValidationError(
          `budget per run oltre il massimo consentito (${opts.maxBudgetUsd} USD)`,
        );
      if (a.action.type === 'guided' && opts.knownTools) {
        const unknown = a.action.allowedTools.filter((t) => !opts.knownTools?.includes(t));
        if (unknown.length)
          throw new AutomationValidationError(`tool sconosciuti: ${unknown.join(', ')}`);
      }
      const kind = a.action.type === 'skill' ? 'deterministic' : 'guided';
      const secret = a.trigger.type === 'webhook' ? randomBytes(24).toString('base64url') : null;
      return withUser(pool, userId, async (client) => {
        const res = await client.query<ARow>(
          `INSERT INTO automations (user_id, key, title, kind, trigger, timezone, action, budget_usd, catch_up, jitter_s, notify, enabled, webhook_secret, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${A_COLS}`,
          [
            userId,
            a.key,
            a.title,
            kind,
            JSON.stringify(a.trigger),
            a.timezone,
            JSON.stringify(a.action),
            a.budgetUsd,
            a.catchUp,
            a.jitterSeconds,
            a.notify,
            a.enabled,
            secret,
            JSON.stringify(a.meta),
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error('creazione automazione fallita');
        return toAutomation(row);
      }).catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new AutomationValidationError(`esiste già un'automazione con chiave «${a.key}»`);
        throw err;
      });
    },

    async setEnabled(userId, id, enabled) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<ARow>(
          `UPDATE automations SET enabled = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${A_COLS}`,
          [id, userId, enabled],
        );
        const row = res.rows[0];
        return row ? toAutomation(row) : null;
      });
    },

    async remove(userId, id) {
      return withUser(
        pool,
        userId,
        async (client) =>
          (
            await client.query(`DELETE FROM automations WHERE id = $1 AND user_id = $2`, [
              id,
              userId,
            ])
          ).rowCount === 1,
      );
    },

    async get(userId, id) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<ARow>(
          `SELECT ${A_COLS} FROM automations WHERE id = $1 AND user_id = $2`,
          [id, userId],
        );
        const row = res.rows[0];
        return row ? toAutomation(row) : null;
      });
    },

    async list(userId) {
      return withUser(pool, userId, async (client) =>
        (
          await client.query<ARow>(
            `SELECT ${A_COLS} FROM automations WHERE user_id = $1 ORDER BY created_at`,
            [userId],
          )
        ).rows.map(toAutomation),
      );
    },

    async listByEvent(userId, eventName) {
      return withUser(pool, userId, async (client) =>
        (
          await client.query<ARow>(
            `SELECT ${A_COLS} FROM automations
              WHERE user_id = $1 AND enabled AND trigger->>'type' = 'event' AND trigger->>'eventName' = $2
              ORDER BY created_at`,
            [userId, eventName],
          )
        ).rows.map(toAutomation),
      );
    },

    async listEnabledForScheduler() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.scheduler', 'on', true)`);
        const res = await client.query<ARow>(
          `SELECT ${A_COLS} FROM automations WHERE enabled ORDER BY created_at`,
        );
        await client.query('COMMIT');
        return res.rows.map(toAutomation);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async webhookTarget(automationId) {
      const res = await pool.query<{
        user_id: string;
        webhook_secret: string | null;
        enabled: boolean;
      }>(`SELECT user_id, webhook_secret, enabled FROM webhook_target($1)`, [automationId]);
      const row = res.rows[0];
      return row ? { userId: row.user_id, secret: row.webhook_secret, enabled: row.enabled } : null;
    },

    async claimRun(input) {
      return withUser(pool, input.userId, async (client) => {
        // Inserimento, oppure ripresa di un tentativo precedente fallito/interrotto con numero di tentativo inferiore.
        const res = await client.query<RRow>(
          `INSERT INTO automation_runs (automation_id, user_id, scheduled_at, dedupe_key, trigger_type, trigger_payload, status, attempt, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,'running',$7, now())
           ON CONFLICT (automation_id, dedupe_key) DO UPDATE
             SET status = 'running', attempt = EXCLUDED.attempt, started_at = now(), error = NULL, finished_at = NULL
           WHERE automation_runs.status IN ('failed', 'running') AND automation_runs.attempt < EXCLUDED.attempt
           RETURNING ${R_COLS}`,
          [
            input.automationId,
            input.userId,
            input.scheduledAt,
            input.dedupeKey,
            input.triggerType,
            input.payload === undefined ? null : JSON.stringify(input.payload),
            input.attempt,
          ],
        );
        const row = res.rows[0];
        return row ? toRun(row) : null;
      });
    },

    async finishRun(userId, runId, f) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<RRow>(
          `UPDATE automation_runs
              SET status = $3, outcome = $4, error = $5, cost_usd = $6, llm_calls = $7, tool_calls = $8,
                  session_id = COALESCE($9, session_id), finished_at = now()
            WHERE id = $1 AND user_id = $2 RETURNING ${R_COLS}`,
          [
            runId,
            userId,
            f.status,
            f.outcome ? JSON.stringify(f.outcome) : null,
            f.error ?? null,
            f.costUsd ?? 0,
            f.llmCalls ?? 0,
            f.toolCalls ?? 0,
            f.sessionId ?? null,
          ],
        );
        const row = res.rows[0];
        return row ? toRun(row) : null;
      });
    },

    async updateRunOutcome(userId, runId, outcome, status) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<RRow>(
          `UPDATE automation_runs SET outcome = $3, status = COALESCE($4, status), finished_at = now()
            WHERE id = $1 AND user_id = $2 RETURNING ${R_COLS}`,
          [runId, userId, JSON.stringify(outcome), status ?? null],
        );
        const row = res.rows[0];
        return row ? toRun(row) : null;
      });
    },

    async getRun(userId, runId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<RRow>(
          `SELECT ${R_COLS} FROM automation_runs WHERE id = $1 AND user_id = $2`,
          [runId, userId],
        );
        const row = res.rows[0];
        return row ? toRun(row) : null;
      });
    },

    async listRuns(userId, automationId, limit = 20) {
      return withUser(pool, userId, async (client) =>
        (
          await client.query<RRow>(
            `SELECT ${R_COLS} FROM automation_runs WHERE automation_id = $1 AND user_id = $2 ORDER BY scheduled_at DESC LIMIT $3`,
            [automationId, userId, limit],
          )
        ).rows.map(toRun),
      );
    },

    async listRecentRuns(userId, limit = 20) {
      return withUser(pool, userId, async (client) =>
        (
          await client.query<RRow>(
            `SELECT ${R_COLS} FROM automation_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
            [userId, limit],
          )
        ).rows.map(toRun),
      );
    },

    async findRunByApproval(userId, approvalId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<RRow>(
          `SELECT ${R_COLS} FROM automation_runs
            WHERE user_id = $1 AND outcome->'pendingActions' @> jsonb_build_array(jsonb_build_object('approvalId', $2::text))
            LIMIT 1`,
          [userId, approvalId],
        );
        const row = res.rows[0];
        return row ? toRun(row) : null;
      });
    },

    async spentTodayUsd(userId, automationId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<{ spent: string }>(
          `SELECT COALESCE(SUM(cost_usd), 0)::text AS spent FROM automation_runs
            WHERE automation_id = $1 AND user_id = $2
              AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [automationId, userId],
        );
        return Number(res.rows[0]?.spent ?? 0);
      });
    },

    async getUserSettings(userId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<{ settings: Record<string, unknown> }>(
          `SELECT settings FROM users WHERE id = $1`,
          [userId],
        );
        return res.rows[0]?.settings ?? {};
      });
    },

    async notify(userId, n) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<NRow>(
          `INSERT INTO notifications (user_id, kind, title, body, payload) VALUES ($1,$2,$3,$4,$5) RETURNING ${N_COLS}`,
          [
            userId,
            n.kind,
            n.title,
            n.body,
            n.payload === undefined ? null : JSON.stringify(n.payload),
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error('notifica non salvata');
        return toNotification(row);
      });
    },

    async listNotifications(userId, unreadOnly = false, limit = 50) {
      return withUser(pool, userId, async (client) =>
        (
          await client.query<NRow>(
            `SELECT ${N_COLS} FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $2`,
            [userId, limit],
          )
        ).rows.map(toNotification),
      );
    },

    async markRead(userId, ids) {
      return withUser(
        pool,
        userId,
        async (client) =>
          (
            await client.query(
              `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
              [userId, [...ids]],
            )
          ).rowCount ?? 0,
      );
    },
  };
}
