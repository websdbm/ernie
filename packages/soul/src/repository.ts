import type { Pool, PoolClient } from '@ernie/db';
import { withUser } from '@ernie/db';
import type { Soul } from './assemble.js';
import { estimateTokens } from './tokens.js';

interface SoulRow {
  id: string;
  key: string;
  kind: Soul['kind'];
  user_id: string | null;
  tags: string[];
  current_version: number;
  content: string;
  token_estimate: number;
  enabled: boolean;
  locked: boolean;
}

const toSoul = (r: SoulRow): Soul => ({
  id: r.id,
  key: r.key,
  kind: r.kind,
  userId: r.user_id,
  tags: r.tags,
  version: r.current_version,
  content: r.content,
  tokenEstimate: r.token_estimate,
  enabled: r.enabled,
  locked: r.locked,
});

const SELECT = `SELECT id, key, kind, user_id, tags, current_version, content, token_estimate, enabled, locked FROM souls`;

export interface SoulRepository {
  /** Soul globali + Soul dell'utente (le policy RLS lasciano passare solo questi). */
  loadForUser(userId: string): Promise<Soul[]>;
  /** Clona i modelli globali come Soul personali dell'utente (idempotente). */
  cloneDefaultsForUser(userId: string, author: string): Promise<number>;
  /** Nuova versione di un Soul dell'utente; i Soul `locked` richiedono `asOwner`. */
  updateContent(
    userId: string,
    key: string,
    content: string,
    author: string,
    reason: string,
    asOwner?: boolean,
  ): Promise<Soul>;
}

export function createSoulRepository(pool: Pool): SoulRepository {
  return {
    async loadForUser(userId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<SoulRow>(
          `${SELECT} WHERE user_id IS NULL OR user_id = $1 ORDER BY key`,
          [userId],
        );
        return res.rows.map(toSoul);
      });
    },

    async cloneDefaultsForUser(userId, author) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `INSERT INTO souls (key, kind, user_id, tags, current_version, content, token_estimate, enabled, locked)
           SELECT g.key, g.kind, $1, g.tags, 1, g.content, g.token_estimate, g.enabled, false
             FROM souls g
            WHERE g.user_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM souls u WHERE u.user_id = $1 AND u.key = g.key)
           RETURNING id, content, token_estimate`,
          [userId],
        );
        for (const row of res.rows as Array<{
          id: string;
          content: string;
          token_estimate: number;
        }>) {
          await client.query(
            `INSERT INTO soul_versions (soul_id, version, content, token_estimate, author, reason) VALUES ($1, 1, $2, $3, $4, 'clonato dai modelli globali')`,
            [row.id, row.content, row.token_estimate, author],
          );
        }
        return res.rowCount ?? 0;
      });
    },

    async updateContent(userId, key, content, author, reason, asOwner = false) {
      return withUser(pool, userId, async (client: PoolClient) => {
        const cur = await client.query<SoulRow>(
          `${SELECT} WHERE user_id = $1 AND key = $2 FOR UPDATE`,
          [userId, key],
        );
        const row = cur.rows[0];
        if (!row) throw new Error(`Soul "${key}" non trovato per l'utente`);
        if (row.locked && !asOwner)
          throw new Error(`Soul "${key}" bloccato: modificabile solo da un owner`);
        const version = row.current_version + 1;
        const tokens = estimateTokens(content);
        await client.query(
          `INSERT INTO soul_versions (soul_id, version, content, token_estimate, author, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.id, version, content, tokens, author, reason],
        );
        const upd = await client.query<SoulRow>(
          `UPDATE souls SET content = $2, token_estimate = $3, current_version = $4, updated_at = now() WHERE id = $1
           RETURNING id, key, kind, user_id, tags, current_version, content, token_estimate, enabled, locked`,
          [row.id, content, tokens, version],
        );
        const updated = upd.rows[0];
        if (!updated) throw new Error('aggiornamento Soul fallito');
        return toSoul(updated);
      });
    },
  };
}
