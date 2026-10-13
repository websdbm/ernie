import { type Pool, withUser } from '@ernie/db';
import { type IntentStore, type StandingIntent, UnknownPersonError } from '@ernie/skills';
import type { FamilyRepository } from './family.js';

/** Promemoria a evento su Postgres (ricerca 11, S1): full-text italiano, freni nel database. */
interface Row {
  id: string;
  trigger_text: string;
  reminder: string;
  fires: number;
  expires_at: Date;
  from_label: string | null;
}
const COLS = 'id, trigger_text, reminder, fires, expires_at, from_label';
const toIntent = (r: Row, forLabel?: string): StandingIntent => ({
  id: r.id,
  trigger: r.trigger_text,
  reminder: r.reminder,
  fires: r.fires,
  expiresAt: r.expires_at,
  ...(r.from_label ? { from: r.from_label } : {}),
  ...(forLabel ? { for: forLabel } : {}),
});

export class GenericTriggerError extends Error {
  constructor() {
    super('argomento troppo generico');
    this.name = 'GenericTriggerError';
  }
}

export function createIntentStore(pool: Pool, family?: FamilyRepository): IntentStore {
  const insert = async (
    owner: string,
    trigger: string,
    reminder: string,
    from?: { id: string; label: string },
  ) =>
    withUser(pool, owner, async (c) => {
      const q = await c.query<{ n: number }>(
        `SELECT numnode(plainto_tsquery('italian', $1)) AS n`,
        [trigger],
      );
      if (!q.rows[0]?.n) throw new GenericTriggerError();
      const r = await c.query<Row>(
        `INSERT INTO standing_intents (user_id, trigger_text, trigger_query, reminder, from_user, from_label)
         VALUES ($1, $2, plainto_tsquery('italian', $2), $3, $4, $5) RETURNING ${COLS}`,
        [
          owner,
          trigger.slice(0, 120),
          reminder.slice(0, 300),
          from?.id ?? null,
          from?.label ?? null,
        ],
      );
      const row = r.rows[0];
      if (!row) throw new Error('promemoria a evento non salvato');
      return row;
    });

  const armed = (owner: string, extra = '', params: unknown[] = []) =>
    withUser(
      pool,
      owner,
      async (c) =>
        (
          await c.query<Row>(
            `SELECT ${COLS} FROM standing_intents WHERE status = 'armed' AND expires_at > now() ${extra} ORDER BY created_at`,
            params,
          )
        ).rows,
    );

  return {
    async create(userId, i) {
      if (!i.forLabel) return toIntent(await insert(userId, i.trigger, i.reminder));
      const link = family ? await family.find(userId, i.forLabel) : null;
      if (!link) throw new UnknownPersonError(i.forLabel);
      const label = (await family?.labelFor(link.otherUserId, userId)) ?? 'un familiare';
      return toIntent(
        await insert(link.otherUserId, i.trigger, i.reminder, { id: userId, label }),
        link.label,
      );
    },
    async list(userId) {
      const mine = (await armed(userId)).map((r) => toIntent(r));
      const others: StandingIntent[] = [];
      for (const link of family ? await family.list(userId) : [])
        for (const r of await armed(link.otherUserId, 'AND from_user = $1', [userId]))
          others.push(toIntent({ ...r, from_label: null }, link.label));
      return [...mine, ...others];
    },
    async cancel(userId, what) {
      const like = `%${what.trim().toLowerCase()}%`;
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `UPDATE standing_intents SET status = 'cancelled'
            WHERE id = (SELECT id FROM standing_intents WHERE status = 'armed'
                         AND (lower(trigger_text) LIKE $1 OR lower(reminder) LIKE $1
                              OR to_tsvector('italian', trigger_text || ' ' || reminder) @@ plainto_tsquery('italian', $2))
                         ORDER BY created_at DESC LIMIT 1)
            RETURNING ${COLS}`,
          [like, what],
        );
        return r.rows[0] ? toIntent(r.rows[0]) : null;
      });
    },
    async fire(userId, text) {
      if (text.trim().length < 3) return [];
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `UPDATE standing_intents SET fires = fires + 1, last_fired_at = now(),
                  status = CASE WHEN fires + 1 >= max_fires THEN 'done' ELSE status END
            WHERE id IN (SELECT id FROM standing_intents
                          WHERE status = 'armed' AND expires_at > now()
                            AND (last_fired_at IS NULL OR last_fired_at < now() - interval '24 hours')
                            AND to_tsvector('italian', $1) @@ trigger_query
                          ORDER BY created_at LIMIT 3)
            RETURNING ${COLS}`,
          [text.slice(0, 4_000)],
        );
        return r.rows.map((x) => toIntent(x));
      });
    },
  };
}
