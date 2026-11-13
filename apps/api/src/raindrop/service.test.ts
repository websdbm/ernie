import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth.js';
import { createHealthCipher } from '../health-protection/crypto.js';
import type { RaindropProvider } from './provider.js';
import { Search } from './provider.js';
import { raindropRoutes } from './routes.js';
import { type ConnectionRecord, createRaindropService, type RaindropStore } from './service.js';

const A = randomUUID(),
  B = randomUUID();
const TOKEN = 'synthetic-raindrop-credential';
function setup() {
  const records = new Map<string, ConnectionRecord>();
  const enabled = new Set<string>([A, B]);
  const store: RaindropStore = {
    get: async (u) => records.get(u) ?? null,
    put: async (u, envelope) => {
      records.set(u, { envelope, updatedAt: '2026-11-13T12:00:00Z' });
    },
    remove: async (u) => {
      records.delete(u);
    },
  };
  const provider: RaindropProvider = {
    account: vi.fn(async () => ({ id: 4, name: 'Synthetic user', pro: true })),
    search: vi.fn(async () => ({ items: [], nextPage: null })),
    get: vi.fn(),
    collections: vi.fn(async () => []),
    save: vi.fn(),
    readTools: vi.fn(),
    read: vi.fn(),
  };
  const cipher = createHealthCipher({
    activeKeyId: 'test',
    keys: new Map([['test', Buffer.alloc(32, 7)]]),
  });
  const deps = { store, provider, cipher, canUse: async (u: string) => enabled.has(u) };
  return { ...deps, records, enabled, service: createRaindropService(deps) };
}
describe('Raindrop private connection and HTTP', () => {
  it('is off by default externally, and does not make provider calls while disabled', async () => {
    const s = setup();
    s.enabled.delete(A);
    await expect(s.service.connect(A, TOKEN)).rejects.toMatchObject({ code: 'skill_disabled' });
    await expect(s.service.search(A, Search.parse({}))).rejects.toMatchObject({
      code: 'skill_disabled',
    });
    expect(s.provider.account).not.toHaveBeenCalled();
    expect(s.provider.search).not.toHaveBeenCalled();
    expect(await s.service.status(A)).toMatchObject({ enabled: false, connected: false });
  });
  it('validates once, encrypts token/account and never exposes the token through status', async () => {
    const s = setup();
    const status = await s.service.connect(A, TOKEN);
    expect(status).toMatchObject({
      connected: true,
      account: { id: 4, name: 'Synthetic user', pro: true },
    });
    expect(JSON.stringify(s.records.get(A))).not.toContain(TOKEN);
    expect(JSON.stringify(s.records.get(A))).not.toContain('Synthetic user');
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(s.provider.account).toHaveBeenCalledTimes(1);
    expect(s.provider.search).not.toHaveBeenCalled();
    expect(await s.service.status(B)).toMatchObject({ connected: false });
    await expect(s.service.search(B, Search.parse({}))).rejects.toMatchObject({
      code: 'not_connected',
    });
    const record = s.records.get(A);
    if (!record) throw new Error('missing test fixture');
    s.records.set(B, record);
    await expect(s.service.status(B)).rejects.toMatchObject({ code: 'connection_unavailable' });
  });
  it('can pause without losing a connection, and disconnect removes local credential even when off', async () => {
    const s = setup();
    await s.service.connect(A, TOKEN);
    s.enabled.delete(A);
    expect(await s.service.status(A)).toMatchObject({ connected: true, enabled: false });
    await s.service.disconnect(A);
    expect(s.records.has(A)).toBe(false);
    expect(s.provider.save).not.toHaveBeenCalled();
  });
  it('blocks results after disable or disconnect while a read is in flight', async () => {
    const s = setup();
    await s.service.connect(A, TOKEN);
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    s.provider.search = async (_t, _i, signal) => {
      started();
      await new Promise<void>((r) => {
        finish = r;
      });
      expect(signal?.aborted).toBe(true);
      return { items: [], nextPage: null };
    };
    const run = s.service.search(A, Search.parse({}));
    await ready;
    await s.service.disconnect(A);
    finish();
    await expect(run).rejects.toMatchObject({ code: 'connection_changed' });
  });
  it('does not reconnect after the user disconnects during credential validation', async () => {
    const s = setup();
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    s.provider.account = async () => {
      started();
      await new Promise<void>((r) => {
        finish = r;
      });
      return { id: 4, name: 'Synthetic user', pro: true };
    };
    const pending = s.service.connect(A, TOKEN);
    await ready;
    await s.service.disconnect(A);
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'connection_changed' });
    expect(s.records.has(A)).toBe(false);
  });
  it('requires the dedicated encryption key and never replaces a valid token after failed validation', async () => {
    const s = setup();
    const missing = createRaindropService({ ...s, cipher: null });
    await expect(missing.connect(A, TOKEN)).rejects.toMatchObject({ code: 'not_configured' });
    await s.service.connect(A, TOKEN);
    const before = s.records.get(A);
    s.provider.account = async () => {
      throw new Error('private provider failure');
    };
    await expect(s.service.connect(A, 'another-synthetic-credential')).rejects.toThrow();
    expect(s.records.get(A)).toBe(before);
  });
  it('authenticates HTTP, prevents user spoofing, suppresses secrets in errors and rejects invalid bodies', async () => {
    const s = setup();
    const api = Fastify();
    const auth: AuthContext = {
      userId: A,
      apiKeyId: randomUUID(),
      role: 'owner',
      scopes: ['chat'],
      companionName: 'Ernie',
      settings: {},
    };
    await raindropRoutes(api, {
      service: s.service,
      allowedOrigins: [],
      authenticator: { authenticate: async (t) => (t === 'good' ? auth : null) },
    });
    try {
      expect((await api.inject('/v1/raindrop')).statusCode).toBe(401);
      const headers = { authorization: 'Bearer good' };
      const bad = await api.inject({
        method: 'PUT',
        url: '/v1/raindrop/connection',
        headers,
        payload: { token: TOKEN, userId: B },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain(TOKEN);
      const good = await api.inject({
        method: 'PUT',
        url: '/v1/raindrop/connection',
        headers,
        payload: { token: TOKEN },
      });
      expect(good.statusCode).toBe(200);
      expect(good.headers['cache-control']).toBe('no-store');
      expect(good.body).not.toContain(TOKEN);
      expect(s.records.has(A)).toBe(true);
      expect(s.records.has(B)).toBe(false);
      s.provider.search = async () => {
        throw new Error(TOKEN);
      };
      const failed = await api.inject({
        method: 'POST',
        url: '/v1/raindrop/search',
        headers,
        payload: {},
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain(TOKEN);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/v1/raindrop/search',
            headers,
            payload: { collectionId: -99 },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await api.close();
    }
  });
});
