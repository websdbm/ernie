import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { meRoutes } from '../routes/me.js';
import { skillsRoutes } from '../routes/skills.js';
import { sshAllowedBySettings } from './service.js';

const OWNER = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL,
  PASSWORD = process.env.APP_DB_PASSWORD;

// I piani SSH in attesa decadono solo se cambia davvero il permesso SSH (skill o interruttore di emergenza),
// non a ogni PATCH delle impostazioni.
describe.skipIf(!OWNER || !PASSWORD)('SSH plan invalidation on settings changes', () => {
  let owner: Pool, app: Pool;
  const users: string[] = [];
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER as string, max: 2 });
    const url = new URL(OWNER as string);
    url.username = 'ernie_app';
    url.password = PASSWORD as string;
    app = createPool({ connectionString: url.toString(), max: 4 });
  });
  afterAll(async () => {
    await owner?.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await app?.end();
    await owner?.end();
  });
  async function setup() {
    const userId = randomUUID();
    users.push(userId);
    await owner.query("INSERT INTO users(id,display_name) VALUES($1,'SSH settings')", [userId]);
    const onSettingsChanged = vi.fn(async () => {});
    const onChanged = vi.fn(
      async (_userId: string, _skillId?: string, _before?: Readonly<Record<string, unknown>>) => {},
    );
    const server = Fastify();
    const authenticator = {
      authenticate: async (key: string) =>
        key === 'valid'
          ? {
              userId,
              apiKeyId: randomUUID(),
              scopes: ['chat'],
              role: 'member' as const,
              companionName: 'Ernie',
              settings: {},
            }
          : null,
    };
    await meRoutes(server, {
      authenticator,
      allowedOrigins: [],
      pool: app,
      version: 'test',
      onSettingsChanged,
    });
    await skillsRoutes(server, { authenticator, allowedOrigins: [], pool: app, onChanged });
    await server.ready();
    const patch = (url: string, payload: Record<string, unknown>) =>
      server.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer valid' }, payload });
    return { server, onSettingsChanged, onChanged, patch };
  }
  it('calls the kill switch hook only when its value really changes', async () => {
    const { server, onSettingsChanged, patch } = await setup();
    expect((await patch('/v1/me/settings', { speakReplies: true })).statusCode).toBe(200);
    expect((await patch('/v1/me/settings', { killSwitch: false })).statusCode).toBe(200);
    expect(onSettingsChanged).not.toHaveBeenCalled();
    await patch('/v1/me/settings', { killSwitch: true });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    await patch('/v1/me/settings', { killSwitch: true, dailyBudgetUsd: 2 });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    await patch('/v1/me/settings', { killSwitch: false });
    expect(onSettingsChanged).toHaveBeenCalledTimes(2);
    await server.close();
  });
  it('passes the previous effective settings so an unchanged SSH permission keeps the plans', async () => {
    const { server, onChanged, patch } = await setup();
    const current = async () =>
      (
        await owner.query<{ settings: Record<string, unknown> }>(
          'SELECT settings FROM users WHERE id=$1',
          [users.at(-1)],
        )
      ).rows[0]?.settings ?? {};
    const before = () => onChanged.mock.calls.at(-1)?.[2] ?? {};
    expect((await patch('/v1/skills/ssh', { enabled: true, available: true })).statusCode).toBe(
      200,
    );
    expect(sshAllowedBySettings(await current())).toBe(true);
    // Stesso valore ripetuto: permesso invariato, index.ts non invalida i piani.
    await patch('/v1/skills/ssh', { enabled: true });
    expect(onChanged.mock.calls.at(-1)?.[1]).toBe('ssh');
    expect(sshAllowedBySettings(before())).toBe(true);
    expect(sshAllowedBySettings(await current())).toBe(true);
    await patch('/v1/skills/ssh', { enabled: false });
    expect(sshAllowedBySettings(before())).toBe(true);
    expect(sshAllowedBySettings(await current())).toBe(false);
    expect(sshAllowedBySettings({ ...(await current()), killSwitch: true })).toBe(false);
    await server.close();
  });
});
