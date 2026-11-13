import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { RaindropError, Token } from './provider.js';

export const RAINDROP_REDIRECT = 'ernie://raindrop-auth';
export const OAuthProof = z.string().regex(/^[a-f0-9]{64}$/);
export const OAuthState = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const OAuthCode = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/);
export interface OAuthGrant {
  token: string;
  refreshToken: string;
  expiresAt: number;
}
export interface OAuthPendingStore {
  put(userId: string, value: string): Promise<void>;
  consume(userId: string, expected: string): Promise<boolean>;
  remove(userId: string): Promise<void>;
}
export function createRaindropOAuthStore(redis: Redis): OAuthPendingStore {
  const key = (u: string) => `ernie:raindrop:oauth:${u}`;
  return {
    async put(u, value) {
      await redis.set(key(u), value, 'EX', 300);
    },
    async consume(u, expected) {
      return (
        (await redis.eval(
          "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
          1,
          key(u),
          expected,
        )) === 1
      );
    },
    async remove(u) {
      await redis.del(key(u));
    },
  };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const unavailable = () =>
  new RaindropError(
    'oauth_unavailable',
    'Accesso Raindrop non disponibile. Riprova il collegamento.',
    503,
  );
export function createRaindropOAuth(
  config: { clientId: string; clientSecret: string },
  store: OAuthPendingStore,
  http: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  // Changing the registered app invalidates authorizations already in flight.
  const fingerprint = hash(`${config.clientId}:${config.clientSecret}`);
  const pending = (state: string, proof: string) =>
    JSON.stringify([hash(state), hash(proof), fingerprint]);
  const exchange = async (
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OAuthGrant> => {
    try {
      const response = await http('https://raindrop.io/oauth/access_token', {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ...body,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw unavailable();
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 32_768) throw unavailable();
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data = z
        .object({
          access_token: Token,
          refresh_token: Token.optional(),
          expires_in: z
            .number()
            .int()
            .positive()
            .max(90 * 86_400),
          token_type: z.string().refine((s) => s.toLowerCase() === 'bearer'),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return {
        token: data.access_token,
        refreshToken: Token.parse(data.refresh_token ?? body.refresh_token),
        expiresAt: now() + data.expires_in * 1000,
      };
    } catch {
      throw unavailable();
    } // Provider bodies, codes and secrets never leave this boundary.
  };
  return {
    cancel: (userId: string) => store.remove(userId),
    async begin(userId: string, proof: string) {
      OAuthProof.parse(proof);
      const state = randomBytes(32).toString('base64url');
      await store.put(userId, pending(state, proof));
      const url = new URL('https://raindrop.io/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: RAINDROP_REDIRECT,
        response_type: 'code',
        state,
      }).toString();
      return { authorizationURL: url.href, state };
    },
    async complete(
      userId: string,
      input: { state: string; verifier: string; code: string },
      signal?: AbortSignal,
    ) {
      OAuthState.parse(input.state);
      OAuthProof.parse(input.verifier);
      OAuthCode.parse(input.code);
      if (!(await store.consume(userId, pending(input.state, input.verifier))))
        throw new RaindropError(
          'oauth_expired',
          'Accesso scaduto o già utilizzato. Premi di nuovo Accedi con Raindrop.',
          409,
        );
      return exchange(
        { grant_type: 'authorization_code', code: input.code, redirect_uri: RAINDROP_REDIRECT },
        signal,
      );
    },
    refresh: (refreshToken: string, signal?: AbortSignal) =>
      exchange({ grant_type: 'refresh_token', refresh_token: Token.parse(refreshToken) }, signal),
  };
}
export type RaindropOAuth = ReturnType<typeof createRaindropOAuth>;
export function raindropOAuthFromEnvironment(env: NodeJS.ProcessEnv, store: OAuthPendingStore) {
  const clientId = env.RAINDROP_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.RAINDROP_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error('Configurazione OAuth Raindrop incompleta.');
  return createRaindropOAuth({ clientId, clientSecret }, store);
}
