import { type Pool, withUser } from '@ernie/db';
import { type AgentEvent, shouldPersist } from '@ernie/protocol';
import type { Redis } from 'ioredis';

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly contextTags: readonly string[];
  readonly modelClass: 'light' | 'standard' | 'heavy';
  readonly createdAt: Date;
  readonly resumed: boolean;
}

export interface ClientInfoInput {
  readonly platform?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly locale?: string | undefined;
}

export class SessionForbiddenError extends Error {
  override readonly name = 'SessionForbiddenError';
}

export interface SessionStore {
  /** Crea la sessione (id scelto dal client) o la riprende se appartiene all'utente. */
  ensure(
    userId: string,
    apiKeyId: string,
    sessionId: string,
    info: ClientInfoInput,
  ): Promise<SessionRecord>;
  touch(userId: string, sessionId: string): Promise<void>;
  /** Alza la classe (mai la abbassa: per quello c'è lowerModelClass). Restituisce la classe effettiva. */
  raiseModelClass(
    userId: string,
    sessionId: string,
    modelClass: 'standard' | 'heavy',
  ): Promise<SessionRecord['modelClass']>;
  /** Discesa da heavy a standard dopo due domande semplici di fila, o con «/classe standard». */
  lowerModelClass(userId: string, sessionId: string): Promise<SessionRecord['modelClass']>;
  /** Classe scelta dall'utente con «/classe heavy»: la discesa automatica non la tocca finché non la cambia lui. */
  pinModelClass(sessionId: string, pinned: boolean): Promise<void>;
  isModelClassPinned(sessionId: string): Promise<boolean>;
  setContextTags(userId: string, sessionId: string, tags: readonly string[]): Promise<void>;
  /** Contaminazione della sessione: contenuto non fidato in cronologia → i turni successivi partono contaminati. */
  markTainted(sessionId: string, source: string, ttlSeconds: number): Promise<void>;
  isTainted(sessionId: string): Promise<boolean>;
  /** Prossimo numero di sequenza server→client (monotono per sessione). */
  nextSeq(sessionId: string): Promise<number>;
  currentSeq(sessionId: string): Promise<number>;
  append(sessionId: string, event: AgentEvent): Promise<void>;
  /** Numera e conserva l'evento in un solo round-trip Redis, prima del trasporto. */
  appendWithSeq?(sessionId: string, event: AgentEvent): Promise<AgentEvent>;
  /** Eventi con seq > afterSeq, nell'ordine di emissione. */
  replay(sessionId: string, afterSeq: number): Promise<AgentEvent[]>;
  /** Una richiesta logica si esegue una volta sola, anche dopo una riconnessione/riavvio. */
  claimRequest(sessionId: string, correlationId: string): Promise<boolean>;
}

export interface SessionStoreOptions {
  readonly logTtlSeconds?: number;
  readonly logMaxEvents?: number;
}

const key = {
  seq: (id: string) => `ernie:sess:${id}:seq`,
  log: (id: string) => `ernie:sess:${id}:log`,
  taint: (id: string) => `ernie:sess:${id}:taint`,
  pinned: (id: string) => `ernie:sess:${id}:class_pinned`,
};

// Non decodificare/ricodificare con cjson: gli array vuoti diventerebbero oggetti.
const APPEND_WITH_SEQ = `
local n = redis.call('INCR', KEYS[1]) - 1
redis.call('EXPIRE', KEYS[1], ARGV[2])
local event = '{"seq":' .. tostring(n) .. ',' .. ARGV[1]
if ARGV[4] == '1' then
  redis.call('RPUSH', KEYS[2], event)
  redis.call('LTRIM', KEYS[2], -tonumber(ARGV[3]), -1)
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
return event
`;

export function createSessionStore(
  pool: Pool,
  redis: Redis,
  opts: SessionStoreOptions = {},
): SessionStore {
  const ttl = opts.logTtlSeconds ?? 24 * 3600;
  const maxEvents = opts.logMaxEvents ?? 500;

  return {
    async claimRequest(sessionId, correlationId) {
      return (
        (await redis.set(
          `ernie:sess:${sessionId}:request:${correlationId}`,
          '1',
          'EX',
          ttl,
          'NX',
        )) === 'OK'
      );
    },
    async ensure(userId, apiKeyId, sessionId, info) {
      return withUser(pool, userId, async (client) => {
        const existing = await client.query<{
          id: string;
          context_tags: string[];
          model_class: SessionRecord['modelClass'];
          created_at: Date;
        }>(`SELECT id, context_tags, model_class, created_at FROM sessions WHERE id = $1`, [
          sessionId,
        ]);
        const row = existing.rows[0];
        if (row) {
          await client.query(
            `UPDATE sessions SET last_seen_at = now(), closed_at = NULL WHERE id = $1`,
            [sessionId],
          );
          return {
            id: row.id,
            userId,
            contextTags: row.context_tags,
            modelClass: row.model_class,
            createdAt: row.created_at,
            resumed: true,
          };
        }
        try {
          const ins = await client.query<{
            id: string;
            context_tags: string[];
            model_class: SessionRecord['modelClass'];
            created_at: Date;
          }>(
            `INSERT INTO sessions (id, user_id, api_key_id, client_platform, client_version, locale)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, context_tags, model_class, created_at`,
            [
              sessionId,
              userId,
              apiKeyId,
              info.platform ?? null,
              info.appVersion ?? null,
              info.locale ?? null,
            ],
          );
          const r = ins.rows[0];
          if (!r) throw new Error('inserimento sessione fallito');
          return {
            id: r.id,
            userId,
            contextTags: r.context_tags,
            modelClass: r.model_class,
            createdAt: r.created_at,
            resumed: false,
          };
        } catch (err) {
          // La RLS nasconde le sessioni altrui: una violazione di chiave primaria significa che l'id è di un altro utente.
          if ((err as { code?: string }).code === '23505')
            throw new SessionForbiddenError('sessione non disponibile');
          throw err;
        }
      });
    },

    async touch(userId, sessionId) {
      await withUser(pool, userId, (client) =>
        client.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]),
      );
    },

    async raiseModelClass(userId, sessionId, modelClass) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<{ model_class: SessionRecord['modelClass'] }>(
          `UPDATE sessions SET model_class = CASE
              WHEN model_class = 'heavy' THEN 'heavy'
              WHEN $2 = 'heavy' THEN 'heavy'
              ELSE 'standard' END
            WHERE id = $1 RETURNING model_class`,
          [sessionId, modelClass],
        );
        return res.rows[0]?.model_class ?? modelClass;
      });
    },

    async lowerModelClass(userId, sessionId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<{ model_class: SessionRecord['modelClass'] }>(
          `UPDATE sessions SET model_class = 'standard' WHERE id = $1 AND model_class = 'heavy'
            RETURNING model_class`,
          [sessionId],
        );
        if (res.rows[0]) return res.rows[0].model_class;
        const cur = await client.query<{ model_class: SessionRecord['modelClass'] }>(
          `SELECT model_class FROM sessions WHERE id = $1`,
          [sessionId],
        );
        return cur.rows[0]?.model_class ?? 'standard';
      });
    },

    async pinModelClass(sessionId, pinned) {
      if (pinned) await redis.set(key.pinned(sessionId), '1', 'EX', 30 * 24 * 3600);
      else await redis.del(key.pinned(sessionId));
    },

    async isModelClassPinned(sessionId) {
      return (await redis.exists(key.pinned(sessionId))) === 1;
    },

    async setContextTags(userId, sessionId, tags) {
      await withUser(pool, userId, (client) =>
        client.query(`UPDATE sessions SET context_tags = $2 WHERE id = $1`, [sessionId, [...tags]]),
      );
    },

    async markTainted(sessionId, source, ttlSeconds) {
      await redis.set(key.taint(sessionId), source.slice(0, 200), 'EX', Math.max(1, ttlSeconds));
    },

    async isTainted(sessionId) {
      return (await redis.exists(key.taint(sessionId))) === 1;
    },

    async nextSeq(sessionId) {
      const results = await redis
        .multi()
        .incr(key.seq(sessionId))
        .expire(key.seq(sessionId), ttl)
        .exec();
      if (!results) throw new Error('numerazione Redis interrotta');
      for (const [error] of results) if (error) throw error;
      return Number(results[0]?.[1]) - 1; // la sequenza parte da 0
    },

    async appendWithSeq(sessionId, event) {
      const { seq: _seq, ...rest } = event;
      const raw = await redis.eval(
        APPEND_WITH_SEQ,
        2,
        key.seq(sessionId),
        key.log(sessionId),
        JSON.stringify(rest).slice(1),
        ttl,
        maxEvents,
        !event.type.startsWith('avatar.') && shouldPersist(event) ? '1' : '0',
      );
      return JSON.parse(String(raw)) as AgentEvent;
    },

    async currentSeq(sessionId) {
      const v = await redis.get(key.seq(sessionId));
      return v ? Number(v) - 1 : -1;
    },

    async append(sessionId, event) {
      if (!shouldPersist(event)) return;
      const results = await redis
        .multi()
        .rpush(key.log(sessionId), JSON.stringify(event))
        .ltrim(key.log(sessionId), -maxEvents, -1)
        .expire(key.log(sessionId), ttl)
        .exec();
      if (!results) throw new Error('persistenza Redis interrotta');
      for (const [error] of results) if (error) throw error;
    },

    async replay(sessionId, afterSeq) {
      const raw = await redis.lrange(key.log(sessionId), 0, -1);
      const events: AgentEvent[] = [];
      for (const r of raw) {
        try {
          const e = JSON.parse(r) as AgentEvent;
          if (e.seq > afterSeq) events.push(e);
        } catch {
          /* voce corrotta: ignorata */
        }
      }
      return events.sort((a, b) => a.seq - b.seq);
    },
  };
}
