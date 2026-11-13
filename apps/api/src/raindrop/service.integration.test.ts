import { randomUUID } from 'node:crypto';
import { createPool, ensureAppRole, type Pool, runMigrations, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHealthCipher } from '../health-protection/crypto.js';
import type { RaindropProvider } from './provider.js';
import { createRaindropService, createRaindropStore } from './service.js';

const url = process.env.RAINDROP_TEST_DATABASE_URL;
const local =
  !!url &&
  new URL(url).hostname === '127.0.0.1' &&
  new URL(url).port === '62205' &&
  new URL(url).pathname === '/ernie';
describe.skipIf(!local)('Raindrop real PostgreSQL RLS and encrypted connection', () => {
  let admin: Pool, app: Pool;
  const A = randomUUID(),
    B = randomUUID();
  const token = 'synthetic-token-database-test';
  beforeAll(async () => {
    if (!url) throw new Error('test database required');
    admin = createPool({ connectionString: url });
    await runMigrations(admin);
    await ensureAppRole(admin, 'raindrop-test-only');
    const appUrl = new URL(url);
    appUrl.username = 'ernie_app';
    appUrl.password = 'raindrop-test-only';
    app = createPool({ connectionString: appUrl.href });
    for (const id of [A, B])
      await admin.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [
        id,
        'Synthetic Raindrop test',
      ]);
  }, 60_000);
  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[A, B]]);
      await admin.end();
    }
    if (app) await app.end();
  });
  it('uses FORCE RLS and per-user authenticated encryption, persists no library or brain data', async () => {
    const cipher = createHealthCipher({
      activeKeyId: 'test',
      keys: new Map([['test', Buffer.alloc(32, 29)]]),
    });
    const provider: RaindropProvider = {
      account: vi.fn(async () => ({ id: 2, name: 'Test Raindrop account', pro: false })),
      search: vi.fn(),
      get: vi.fn(),
      collections: vi.fn(),
      save: vi.fn(),
      read: vi.fn(),
      readTools: vi.fn(),
    };
    const store = createRaindropStore(app);
    const service = createRaindropService({ store, cipher, provider, canUse: async () => true });
    await service.connect(A, token);
    expect(await store.get(B)).toBeNull();
    const raw = (
      await admin.query('SELECT envelope FROM raindrop_connections WHERE user_id=$1', [A])
    ).rows[0]?.envelope;
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(JSON.stringify(raw)).not.toContain('Test Raindrop account');
    const rls = await withUser(app, B, (c) =>
      c.query('SELECT * FROM raindrop_connections WHERE user_id=$1', [A]),
    );
    expect(rls.rows).toEqual([]);
    await expect(
      withUser(app, B, (c) =>
        c.query('INSERT INTO raindrop_connections(user_id,envelope) VALUES($1,$2)', [A, '{}']),
      ),
    ).rejects.toThrow();
    expect(await service.status(A)).toMatchObject({
      connected: true,
      account: { id: 2, pro: false },
    });
    // Recreating the service proves the token is readable after restart, without a token cache.
    expect(
      await createRaindropService({ store, cipher, provider, canUse: async () => true }).status(A),
    ).toMatchObject({ connected: true });
    for (const table of ['brain_notes', 'memories', 'automations']) {
      const r = await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [A]);
      expect(r.rows[0]?.n).toBe(0);
    }
    await service.disconnect(A);
    expect(await store.get(A)).toBeNull();
    cipher.destroy();
  });
});
