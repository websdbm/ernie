import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth.js';
import { createHealthCipher } from '../health-protection/crypto.js';
import {
  createRaindropOAuth,
  createRaindropOAuthStore,
  type OAuthPendingStore,
  raindropOAuthFromEnvironment,
} from './oauth.js';
import { type RaindropProvider, Search } from './provider.js';
import { raindropRoutes } from './routes.js';
import { type ConnectionRecord, createRaindropService } from './service.js';

const A = randomUUID(),
  B = randomUUID(),
  proof = 'a'.repeat(64);
const token = 'synthetic-oauth-access-token',
  refresh = 'synthetic-oauth-refresh-token';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup() {
  let now = 1_000_000;
  const pending = new Map<string, { value: string; expiry: number }>();
  const sessions: OAuthPendingStore = {
    async put(u, value) {
      pending.set(u, { value, expiry: now + 300_000 });
    },
    async consume(u, expected) {
      const p = pending.get(u);
      if (!p || p.expiry <= now || p.value !== expected) return false;
      pending.delete(u);
      return true;
    },
    async remove(u) {
      pending.delete(u);
    },
  };
  const http = vi.fn<typeof fetch>(async () =>
    json({ access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: 7200 }),
  );
  const oauth = createRaindropOAuth(
    { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
    sessions,
    http,
    () => now,
  );
  const records = new Map<string, ConnectionRecord>();
  const enabled = new Set<string>([A, B]);
  const provider: RaindropProvider = {
    account: vi.fn(async () => ({ id: 7, name: 'Synthetic', pro: true })),
    search: vi.fn(async () => ({ items: [], nextPage: null })),
    get: vi.fn(),
    collections: vi.fn(async () => []),
    save: vi.fn(),
    readTools: vi.fn(),
    read: vi.fn(),
  };
  const cipher = createHealthCipher({
    activeKeyId: 'test',
    keys: new Map([['test', Buffer.alloc(32, 8)]]),
  });
  const service = createRaindropService({
    oauth,
    provider,
    cipher,
    now: () => now,
    canUse: async (u) => enabled.has(u),
    store: {
      get: async (u) => records.get(u) ?? null,
      async put(u, envelope) {
        records.set(u, { envelope, updatedAt: new Date(now).toISOString() });
      },
      async remove(u) {
        records.delete(u);
      },
    },
  });
  return {
    oauth,
    service,
    http,
    records,
    pending,
    provider,
    enabled,
    sessions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('Raindrop browser authorization', () => {
  it('uses a fixed redirect, random state, hashed client proof and no client secret in the browser', async () => {
    const s = setup();
    const start = await s.service.beginOAuth(A, proof);
    const url = new URL(start.authorizationURL);
    expect(url.origin).toBe('https://raindrop.io');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('ernie://raindrop-auth');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(start)).not.toContain('synthetic-secret');
    expect(JSON.stringify(start)).not.toContain(proof);
    expect(s.pending.get(A)?.value).not.toContain(proof);
    expect(s.pending.get(A)?.value).not.toContain(start.state);
    expect(s.http).not.toHaveBeenCalled();
  });
  it('prevents cross-account completion, wrong state, wrong proof and replay without burning the valid session', async () => {
    const s = setup(),
      { state } = await s.oauth.begin(A, proof);
    const input = { state, verifier: proof, code: 'synthetic-code' };
    for (const [u, value] of [
      [B, input],
      [A, { ...input, state: 'x'.repeat(43) }],
      [A, { ...input, verifier: 'b'.repeat(64) }],
    ] as const)
      await expect(s.oauth.complete(u, value)).rejects.toMatchObject({ code: 'oauth_expired' });
    expect(s.http).not.toHaveBeenCalled();
    await s.oauth.complete(A, input);
    await expect(s.oauth.complete(A, input)).rejects.toMatchObject({ code: 'oauth_expired' });
    expect(s.http).toHaveBeenCalledTimes(1);
    const call = s.http.mock.calls[0];
    if (!call) throw new Error('missing exchange call');
    const [url, init] = call;
    expect(url).toBe('https://raindrop.io/oauth/access_token');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      code: input.code,
      client_secret: 'synthetic-secret',
      grant_type: 'authorization_code',
    });
  });
  it('expires after five minutes and replaces older attempts', async () => {
    const s = setup(),
      first = await s.oauth.begin(A, proof),
      next = await s.oauth.begin(A, proof);
    await expect(
      s.oauth.complete(A, { state: first.state, verifier: proof, code: 'old' }),
    ).rejects.toMatchObject({ code: 'oauth_expired' });
    s.advance(300_001);
    await expect(
      s.oauth.complete(A, { state: next.state, verifier: proof, code: 'expired' }),
    ).rejects.toMatchObject({ code: 'oauth_expired' });
    expect(s.http).not.toHaveBeenCalled();
  });
  it('validates the account, encrypts both credentials and exposes neither through status', async () => {
    const s = setup(),
      { state } = await s.service.beginOAuth(A, proof);
    const result = await s.service.completeOAuth(A, {
      state,
      verifier: proof,
      code: 'synthetic-code',
    });
    expect(result).toMatchObject({ connected: true, oauthConfigured: true, account: { id: 7 } });
    expect(JSON.stringify([...s.records.values()])).not.toMatch(/synthetic-oauth|Synthetic/);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(refresh);
    expect(s.provider.account).toHaveBeenCalledWith(token, expect.any(AbortSignal));
    expect(s.provider.search).not.toHaveBeenCalled();
  });
  it('disconnect and skill changes invalidate unfinished browser login', async () => {
    const s = setup(),
      { state } = await s.service.beginOAuth(A, proof);
    await s.service.disconnect(A);
    await expect(
      s.service.completeOAuth(A, { state, verifier: proof, code: 'old' }),
    ).rejects.toMatchObject({ code: 'oauth_expired' });
    s.enabled.delete(A);
    await expect(s.service.beginOAuth(A, proof)).rejects.toMatchObject({ code: 'skill_disabled' });
    expect(s.http).not.toHaveBeenCalled();
    expect(s.records.size).toBe(0);
  });
  it('does not restore the connection when disconnected during the token exchange', async () => {
    const s = setup(),
      { state } = await s.service.beginOAuth(A, proof);
    let finish!: (r: Response) => void, entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    s.http.mockImplementation(async () => {
      entered();
      return new Promise((r) => {
        finish = r;
      });
    });
    const running = s.service.completeOAuth(A, { state, verifier: proof, code: 'synthetic' });
    await ready;
    await s.service.disconnect(A);
    finish(
      json({ access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: 7200 }),
    );
    await expect(running).rejects.toMatchObject({ code: 'connection_changed' });
    expect(s.records.size).toBe(0);
  });
  it('serializes automatic refresh, rotates the encrypted refresh credential and keeps manual tokens working', async () => {
    const s = setup(),
      { state } = await s.service.beginOAuth(A, proof);
    await s.service.completeOAuth(A, { state, verifier: proof, code: 'synthetic' });
    s.advance(7200_000);
    s.http.mockImplementation(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: refresh,
      });
      return json({
        access_token: 'new-synthetic-access-token',
        refresh_token: 'new-synthetic-refresh-token',
        token_type: 'Bearer',
        expires_in: 7200,
      });
    });
    await Promise.all([s.service.search(A, Search.parse({})), s.service.collections(A)]);
    expect(s.http).toHaveBeenCalledTimes(2); // exchange + one refresh
    expect(s.provider.search).toHaveBeenCalledWith(
      'new-synthetic-access-token',
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify([...s.records.values()])).not.toContain('new-synthetic');
    await s.service.connect(B, 'manual-synthetic-token');
    s.advance(90_000_000);
    await s.service.collections(B);
    expect(s.http).toHaveBeenCalledTimes(2);
  });
  it('keeps the existing connection after failed authorization and never leaks refresh errors', async () => {
    const s = setup();
    await s.service.connect(A, 'existing-manual-synthetic-token');
    const before = s.records.get(A);
    const { state } = await s.service.beginOAuth(A, proof);
    s.http.mockResolvedValue(json({ private: refresh }, 401));
    await expect(
      s.service.completeOAuth(A, { state, verifier: proof, code: 'bad' }),
    ).rejects.toMatchObject({ code: 'oauth_unavailable' });
    expect(s.records.get(A)).toBe(before);
    expect((await s.service.status(A)).connected).toBe(true);
  });
  it('does not repopulate encrypted credentials after disconnect during refresh', async () => {
    const s = setup(),
      { state } = await s.service.beginOAuth(A, proof);
    await s.service.completeOAuth(A, { state, verifier: proof, code: 'synthetic' });
    s.advance(7200_000);
    let finish!: (r: Response) => void, entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    s.http.mockImplementation(async () => {
      entered();
      return new Promise((r) => {
        finish = r;
      });
    });
    const running = s.service.collections(A);
    const rejected = expect(running).rejects.toMatchObject({ code: 'connection_changed' });
    await ready;
    const disconnected = s.service.disconnect(A);
    finish(
      json({ access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: 7200 }),
    );
    await rejected;
    await disconnected;
    expect(s.records.size).toBe(0);
  });
  it.each([400, 401, 429, 500])(
    'does not retry or disclose failed exchange payload (%i)',
    async (status) => {
      const s = setup(),
        { state } = await s.oauth.begin(A, proof);
      s.http.mockResolvedValue(json({ secret: token }, status));
      await expect(
        s.oauth.complete(A, { state, verifier: proof, code: 'private-code' }),
      ).rejects.not.toThrow(token);
      expect(s.http).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds token responses, refuses malformed grants and makes OAuth optional', async () => {
    const s = setup();
    expect(raindropOAuthFromEnvironment({}, s.sessions)).toBeNull();
    expect(() =>
      raindropOAuthFromEnvironment({ RAINDROP_OAUTH_CLIENT_ID: 'id' }, s.sessions),
    ).toThrow('incompleta');
    for (const response of [new Response('x'.repeat(32769)), json({ access_token: token })]) {
      const { state } = await s.oauth.begin(A, proof);
      s.http.mockResolvedValue(response);
      await expect(
        s.oauth.complete(A, { state, verifier: proof, code: 'code' }),
      ).rejects.toMatchObject({ code: 'oauth_unavailable' });
    }
  });
  it('authenticates both endpoints, rejects account spoofing and excludes secrets from HTTP responses', async () => {
    const s = setup(),
      app = Fastify();
    const auth: AuthContext = {
      userId: A,
      apiKeyId: randomUUID(),
      role: 'owner',
      scopes: ['chat'],
      companionName: 'Ernie',
      settings: {},
    };
    await raindropRoutes(app, {
      service: s.service,
      allowedOrigins: [],
      authenticator: { authenticate: async (t) => (t === 'good' ? auth : null) },
    });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/raindrop/oauth/start',
            payload: { verifier: proof },
          })
        ).statusCode,
      ).toBe(401);
      const headers = { authorization: 'Bearer good' };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/raindrop/oauth/start',
            headers,
            payload: { verifier: proof, userId: B },
          })
        ).statusCode,
      ).toBe(400);
      const start = await app.inject({
        method: 'POST',
        url: '/v1/raindrop/oauth/start',
        headers,
        payload: { verifier: proof },
      });
      expect(start.headers['cache-control']).toBe('no-store');
      const done = await app.inject({
        method: 'POST',
        url: '/v1/raindrop/oauth/complete',
        headers,
        payload: { state: start.json().state, verifier: proof, code: 'synthetic' },
      });
      expect(done.statusCode).toBe(200);
      expect(done.body).not.toContain(token);
      expect(done.body).not.toContain(refresh);
    } finally {
      await app.close();
    }
  });
});

const redisURL = process.env.RAINDROP_TEST_REDIS_URL;
const localRedis = redisURL === 'redis://127.0.0.1:62206/15';
describe.skipIf(!localRedis)('Raindrop OAuth atomic Redis session', () => {
  it('consumes exactly once across concurrent clients, preserves mismatches and expires without retaining secrets', async () => {
    const redis = new Redis(redisURL ?? 'redis://127.0.0.1:62206/15', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    const u = randomUUID(),
      key = `ernie:raindrop:oauth:${u}`;
    try {
      await redis.connect();
      const store = createRaindropOAuthStore(redis);
      await store.put(u, 'hashed-state-and-proof-only');
      expect(await redis.ttl(key)).toBeGreaterThan(290);
      expect(await store.consume(u, 'wrong')).toBe(false);
      expect(await store.consume(randomUUID(), 'hashed-state-and-proof-only')).toBe(false);
      const result = await Promise.all(
        Array.from({ length: 8 }, () => store.consume(u, 'hashed-state-and-proof-only')),
      );
      expect(result.filter(Boolean)).toHaveLength(1);
      expect(await redis.exists(key)).toBe(0);
      await store.put(u, 'another-session');
      await redis.expire(key, 0);
      expect(await store.consume(u, 'another-session')).toBe(false);
      await store.put(u, 'cancelled-session');
      await store.remove(u);
      expect(await store.consume(u, 'cancelled-session')).toBe(false);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  });
});
