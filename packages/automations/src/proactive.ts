import { randomUUID } from 'node:crypto';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';
import { addDays, localParts, zonedToUtc } from '@ernie/skills';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { publishUserEvent } from './notify.js';
import type { PushSender } from './push.js';
import type { AutomationRepository } from './repository.js';

/**
 * Gate della proattività (M9 A3, idea presa da Muffin). Ernie parla per primo solo se:
 * 1. il motivo è in un insieme CHIUSO (aggiungerne uno è una modifica al codice, con test);
 * 2. si basa su evidenze dell'utente o della famiglia, mai su contenuti non fidati (web, documenti, tool);
 * 3. l'utente non ha spento i messaggi spontanei;
 * 4. non è nelle ore di quiete (predefinite 22:00–07:30: il messaggio aspetta la fine);
 * 5. non supera il tetto giornaliero (predefinito 4) né l'intervallo minimo tra due messaggi (45 minuti).
 * Il registro `proactive_messages` è anche il lock d'invio: una chiave per motivo, un solo consegnatario.
 * Non passano di qui i promemoria e le automazioni: li ha chiesti l'utente, a un'ora da lui scelta.
 */
export const ProactiveKind = z.enum(['approval_expiring', 'family_reminder']);
export type ProactiveKind = z.infer<typeof ProactiveKind>;

export interface ProactiveCandidate {
  readonly userId: string;
  readonly kind: ProactiveKind;
  /** Una sola consegna per chiave (es. `approval_expiring:<id>`). */
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  readonly payload?: Record<string, unknown>;
  /** Su cosa si basa: dati o configurazione dell'utente, oppure un'azione di un familiare collegato. */
  readonly evidence: { readonly source: 'user' | 'family'; readonly refs: readonly string[] };
  /** Nato (anche in parte) da contenuti non fidati: mai consegnato. */
  readonly tainted?: boolean;
}

export const PROACTIVE_DEFAULTS = {
  quietStart: '22:00',
  quietEnd: '07:30',
  dailyCap: 4,
  minGapMinutes: 45,
} as const;

export interface GateState {
  readonly now: Date;
  readonly timezone: string;
  readonly settings: Readonly<Record<string, unknown>>;
  /** Messaggi spontanei già consegnati oggi (giorno locale). */
  readonly sentToday: number;
  readonly lastSentAt: Date | null;
}

export type GateVerdict =
  | { readonly verdict: 'send' }
  | { readonly verdict: 'defer'; readonly until: Date; readonly reason: string }
  | { readonly verdict: 'drop'; readonly reason: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (s: string): number | null => {
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Ore di quiete dalle impostazioni (`quietHours: { start, end }`, `null` = nessuna). */
export function quietWindow(
  settings: Readonly<Record<string, unknown>>,
): { start: number; end: number } | null {
  const q = settings.quietHours;
  if (q === null) return null;
  const rec = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
  const start = minutes(typeof rec.start === 'string' ? rec.start : PROACTIVE_DEFAULTS.quietStart);
  const end = minutes(typeof rec.end === 'string' ? rec.end : PROACTIVE_DEFAULTS.quietEnd);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

/** Se `now` cade nelle ore di quiete, l'istante in cui finiscono; altrimenti null. */
export function quietUntil(
  now: Date,
  tz: string,
  w: { start: number; end: number } | null,
): Date | null {
  if (!w) return null;
  const p = localParts(now, tz);
  const cur = p.hour * 60 + p.minute;
  const inside = w.start < w.end ? cur >= w.start && cur < w.end : cur >= w.start || cur < w.end;
  if (!inside) return null;
  // La fine è oggi se siamo prima di `end`, altrimenti domani (finestra a cavallo della mezzanotte).
  const [y, mo, d] = cur < w.end ? [p.year, p.month, p.day] : addDays(p.year, p.month, p.day, 1);
  return zonedToUtc(tz, y, mo, d, Math.floor(w.end / 60), w.end % 60);
}

/** Decisione pura: nessun I/O, testabile per ogni regola. */
export function decideProactive(c: ProactiveCandidate, s: GateState): GateVerdict {
  if (!ProactiveKind.safeParse(c.kind).success)
    return { verdict: 'drop', reason: 'motivo non ammesso' };
  if (c.tainted) return { verdict: 'drop', reason: 'nato da contenuti non fidati' };
  if (c.evidence.source !== 'user' && c.evidence.source !== 'family')
    return { verdict: 'drop', reason: 'evidenza non dell’utente' };
  if (s.settings.proactive === false)
    return { verdict: 'drop', reason: 'messaggi spontanei spenti' };
  const quiet = quietUntil(s.now, s.timezone, quietWindow(s.settings));
  if (quiet) return { verdict: 'defer', until: quiet, reason: 'ore di quiete' };
  const capRaw = s.settings.proactiveDailyCap;
  const cap =
    typeof capRaw === 'number' && Number.isInteger(capRaw) && capRaw >= 0
      ? capRaw
      : PROACTIVE_DEFAULTS.dailyCap;
  if (s.sentToday >= cap)
    return { verdict: 'drop', reason: `tetto giornaliero (${cap}) raggiunto` };
  if (s.lastSentAt) {
    const next = s.lastSentAt.getTime() + PROACTIVE_DEFAULTS.minGapMinutes * 60_000;
    if (next > s.now.getTime())
      return {
        verdict: 'defer',
        until: new Date(next),
        reason: 'intervallo minimo tra due messaggi',
      };
  }
  return { verdict: 'send' };
}

export interface ProactiveDeps {
  readonly pool: Pool;
  readonly repo: Pick<AutomationRepository, 'notify' | 'getUserSettings'>;
  readonly redis: Pick<Redis, 'publish'>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly push?: PushSender;
  readonly timezone?: string;
  readonly now?: () => Date;
  /** Dopo la consegna (es. l'API mostra subito la scheda nelle sessioni connesse). */
  readonly onDelivered?: (c: ProactiveCandidate) => Promise<void>;
}

interface Row {
  id: string;
  user_id: string;
  kind: ProactiveKind;
  dedupe_key: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  evidence: ProactiveCandidate['evidence'];
}

const toCandidate = (r: Row): ProactiveCandidate => ({
  userId: r.user_id,
  kind: r.kind,
  dedupeKey: r.dedupe_key,
  title: r.title,
  body: r.body,
  ...(r.payload ? { payload: r.payload } : {}),
  evidence: r.evidence,
});

async function gateState(
  deps: ProactiveDeps,
  userId: string,
  now: Date,
  tz: string,
): Promise<GateState> {
  const p = localParts(now, tz);
  const dayStart = zonedToUtc(tz, p.year, p.month, p.day, 0, 0);
  const [settings, counts] = await Promise.all([
    deps.repo.getUserSettings(userId),
    withUser(deps.pool, userId, async (c) => {
      const r = await c.query<{ n: string; last: Date | null }>(
        `SELECT count(*) FILTER (WHERE sent_at >= $1)::text AS n, max(sent_at) AS last
           FROM proactive_messages WHERE status = 'sent'`,
        [dayStart],
      );
      return r.rows[0];
    }),
  ]);
  return {
    now,
    timezone: tz,
    settings,
    sentToday: Number(counts?.n ?? 0),
    lastSentAt: counts?.last ?? null,
  };
}

/** Consegna atomica: vince chi porta la riga da pending a sent (API e worker possono provarci insieme). */
async function deliver(
  deps: ProactiveDeps,
  rowId: string,
  c: ProactiveCandidate,
): Promise<boolean> {
  const claimed = await withUser(deps.pool, c.userId, async (cl) => {
    const r = await cl.query(
      `UPDATE proactive_messages SET status = 'sent', sent_at = now(), reason = NULL
        WHERE id = $1 AND status = 'pending'`,
      [rowId],
    );
    return (r.rowCount ?? 0) === 1;
  });
  if (!claimed) return false;
  const n = await deps.repo.notify(c.userId, {
    kind: `proactive.${c.kind}`,
    title: c.title,
    body: c.body,
    payload: {
      ...Object.fromEntries(Object.entries(c.payload ?? {}).filter(([k]) => k !== 'block')),
      proactive: true,
    },
  });
  await deps.push
    ?.notifyUser(c.userId, {
      title: c.title,
      body: c.body,
      data: { kind: n.kind, notificationId: n.id },
      threadId: 'proactive',
    })
    .catch((err: unknown) => deps.logger.warn({ err }, 'push del messaggio spontaneo non inviata'));
  await publishUserEvent(deps.redis, {
    userId: c.userId,
    type: 'inbox.updated',
    payload: { kind: n.kind },
  }).catch((err: unknown) => deps.logger.warn({ err }, 'evento inbox.updated non pubblicato'));
  // Scheda allegata (es. il promemoria messo da un familiare): alle sessioni connesse, via Redis.
  const block = c.payload?.block;
  if (block && typeof block === 'object')
    await publishUserEvent(deps.redis, {
      userId: c.userId,
      type: 'assistant.block',
      payload: { blockId: randomUUID(), block: block as never },
    }).catch((err: unknown) =>
      deps.logger.warn({ err }, 'scheda del messaggio spontaneo non inviata'),
    );
  await deps
    .onDelivered?.(c)
    .catch((err: unknown) =>
      deps.logger.warn({ err }, 'consegna live del messaggio spontaneo non riuscita'),
    );
  deps.logger.info(
    { userId: c.userId, kind: c.kind, key: c.dedupeKey },
    'messaggio spontaneo consegnato',
  );
  return true;
}

export type OfferOutcome = GateVerdict['verdict'] | 'duplicate';

/**
 * Propone un messaggio spontaneo: lo registra (una volta per chiave) e lo consegna subito, lo rimanda
 * (lo consegnerà il worker) o lo scarta con il motivo. Restituisce l'esito.
 */
export async function offerProactive(
  deps: ProactiveDeps,
  c: ProactiveCandidate,
): Promise<OfferOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const tz = deps.timezone ?? 'Europe/Rome';
  const state = await gateState(deps, c.userId, now, tz);
  const v = decideProactive(c, state);
  const row = await withUser(deps.pool, c.userId, async (cl) => {
    const r = await cl.query<{ id: string }>(
      `INSERT INTO proactive_messages (user_id, kind, dedupe_key, title, body, payload, evidence, status, reason, not_before)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
      [
        c.userId,
        c.kind,
        c.dedupeKey,
        c.title.slice(0, 200),
        c.body.slice(0, 2000),
        c.payload ? JSON.stringify(c.payload) : null,
        JSON.stringify(c.evidence),
        v.verdict === 'drop' ? 'dropped' : 'pending',
        v.verdict === 'send' ? null : v.reason,
        v.verdict === 'defer' ? v.until : now,
      ],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return 'duplicate';
  if (v.verdict !== 'send') {
    deps.logger.info(
      { userId: c.userId, kind: c.kind, verdict: v.verdict, reason: v.reason },
      'messaggio spontaneo non consegnato ora',
    );
    return v.verdict;
  }
  await deliver(deps, row.id, c);
  return 'send';
}

/** Worker: consegna i messaggi rimandati il cui momento è arrivato, ripassando dal gate. */
export async function deliverDueProactive(deps: ProactiveDeps, limit = 50): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const tz = deps.timezone ?? 'Europe/Rome';
  const due = await schedulerRead(
    deps.pool,
    async (cl) =>
      (
        await cl.query<Row>(
          `SELECT id, user_id, kind, dedupe_key, title, body, payload, evidence FROM proactive_messages
          WHERE status = 'pending' AND not_before <= $1 ORDER BY not_before LIMIT $2`,
          [now, limit],
        )
      ).rows,
  );
  let sent = 0;
  for (const r of due) {
    const c = toCandidate(r);
    const v = decideProactive(c, await gateState(deps, c.userId, now, tz));
    if (v.verdict === 'send') {
      if (await deliver(deps, r.id, c)) sent++;
      continue;
    }
    await withUser(deps.pool, c.userId, (cl) =>
      cl.query(
        v.verdict === 'drop'
          ? `UPDATE proactive_messages SET status = 'dropped', reason = $2 WHERE id = $1 AND status = 'pending'`
          : `UPDATE proactive_messages SET not_before = $3, reason = $2 WHERE id = $1 AND status = 'pending'`,
        v.verdict === 'drop' ? [r.id, v.reason] : [r.id, v.reason, v.until],
      ),
    );
  }
  return sent;
}

/** Produttore «conferma in scadenza»: approvazioni differite in attesa da ore che scadono entro un giorno. */
export async function produceApprovalReminders(deps: ProactiveDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await schedulerRead(
    deps.pool,
    async (cl) =>
      (
        await cl.query<{ id: string; user_id: string; tool_id: string; expires_at: Date }>(
          `SELECT id, user_id, tool_id, expires_at FROM tool_approvals
          WHERE status = 'pending' AND expires_at > $1::timestamptz + interval '1 hour' AND expires_at < $1::timestamptz + interval '24 hours'
            AND created_at < $1::timestamptz - interval '12 hours'
          ORDER BY expires_at LIMIT 100`,
          [now],
        )
      ).rows,
  );
  let offered = 0;
  for (const r of rows) {
    const hours = Math.max(1, Math.round((r.expires_at.getTime() - now.getTime()) / 3_600_000));
    const outcome = await offerProactive(deps, {
      userId: r.user_id,
      kind: 'approval_expiring',
      dedupeKey: `approval_expiring:${r.id}`,
      title: 'Un’azione aspetta la tua conferma',
      body: `Un’automazione ha preparato un’azione (${r.tool_id}) che aspetta il tuo sì: scade tra circa ${hours} ${hours === 1 ? 'ora' : 'ore'}. Aprila nella scheda di approvazione per confermarla o rifiutarla.`,
      payload: { approvalId: r.id, toolId: r.tool_id, expiresAt: r.expires_at.toISOString() },
      evidence: { source: 'user', refs: [`tool_approvals:${r.id}`] },
    });
    if (outcome !== 'duplicate') offered++;
  }
  return offered;
}

async function schedulerRead<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.scheduler', 'on', true)`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
