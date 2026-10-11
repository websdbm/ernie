import { createHash, randomBytes } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';

export const API_KEY_PREFIX = 'ernie_';

export interface AuthContext {
  readonly userId: string;
  readonly apiKeyId: string;
  readonly scopes: readonly string[];
  readonly role: 'owner' | 'member';
  readonly companionName: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** Chiave mostrata una sola volta alla creazione; nel database resta solo l'hash. */
export function generateApiKey(): { key: string; hash: Buffer } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key) };
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}

export interface Authenticator {
  authenticate(bearer: string | undefined): Promise<AuthContext | null>;
}

/**
 * Due passi per rispettare la RLS: la ricerca per hash su api_keys (esente da RLS, solo hash e
 * metadati), poi la lettura dell'utente dentro una transazione con app.user_id impostato.
 */
export function createAuthenticator(pool: Pool): Authenticator {
  return {
    async authenticate(bearer) {
      if (!bearer?.startsWith(API_KEY_PREFIX) || bearer.length < 20) return null;
      const hash = hashApiKey(bearer);
      const key = await pool.query<{ id: string; user_id: string; scopes: string[] }>(
        `SELECT id, user_id, scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
        [hash],
      );
      const k = key.rows[0];
      if (!k) return null;
      const user = await withUser(pool, k.user_id, async (client) => {
        await client.query(
          `UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
          [k.id],
        );
        const u = await client.query<{
          role: 'owner' | 'member';
          companion_name: string;
          settings: Record<string, unknown>;
        }>(`SELECT role, companion_name, settings FROM users WHERE id = $1`, [k.user_id]);
        return u.rows[0];
      });
      if (!user) return null;
      return {
        userId: k.user_id,
        apiKeyId: k.id,
        scopes: k.scopes,
        role: user.role,
        companionName: user.companion_name,
        settings: user.settings,
      };
    },
  };
}
