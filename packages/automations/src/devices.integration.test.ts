import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeviceRepository } from './devices.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('repository dispositivi (Postgres, ruolo applicativo + RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'A'), ($2, 'B')`, [
      userA,
      userB,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('rimuove solo il token del proprio utente, in modo idempotente', async () => {
    const repo = createDeviceRepository(app);
    const token = randomUUID().replaceAll('-', '');
    await repo.register(userA, { platform: 'ios', token, environment: 'development' });
    expect(await repo.remove(userB, token)).toBe(false);
    expect(await repo.list(userA)).toHaveLength(1);
    expect(await repo.remove(userA, token.toUpperCase())).toBe(true);
    expect(await repo.remove(userA, token)).toBe(false);
  });

  it('trasferisce il token al nuovo account e un logout tardivo del precedente non lo rimuove', async () => {
    const repo = createDeviceRepository(app);
    const token = randomUUID().replaceAll('-', '');
    const input = { platform: 'ios' as const, token, environment: 'development' as const };
    await repo.register(userA, input);
    await repo.register(userB, input);
    expect(await repo.list(userA)).toHaveLength(0);
    expect(await repo.list(userB)).toHaveLength(1);
    expect(await repo.remove(userA, token)).toBe(false);
    expect(await repo.list(userB)).toHaveLength(1);
  });
});
