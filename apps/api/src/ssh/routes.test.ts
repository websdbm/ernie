import { randomUUID } from 'node:crypto';
import { SshSnapshot } from '@ernie/protocol';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sshRoutes } from './routes.js';
import type { SshService } from './service.js';
import { createSshTools } from './tools.js';
import { SshError } from './types.js';

const userId = randomUUID(),
  empty = SshSnapshot.parse({
    configured: true,
    key: null,
    servers: [],
    sites: [],
    providers: [],
    operations: [],
  });
const apps: ReturnType<typeof Fastify>[] = [];
async function setup(scopes = ['chat']) {
  const app = Fastify();
  apps.push(app);
  const service = {
    snapshot: vi.fn(async () => empty),
    approve: vi.fn(),
    reject: vi.fn(),
    providerSave: vi.fn(async () => empty),
  } as unknown as SshService;
  await sshRoutes(app, {
    service,
    allowedOrigins: [],
    authenticator: {
      authenticate: async (key) =>
        key === 'valid'
          ? {
              userId,
              apiKeyId: randomUUID(),
              scopes,
              role: 'member',
              companionName: 'Ernie',
              settings: {},
            }
          : null,
    },
  });
  await app.ready();
  return { app, service };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe('SSH REST and model-only planning boundary', () => {
  it('requires authentication and chat scope, and passes only authenticated identity', async () => {
    const { app, service } = await setup();
    expect((await app.inject('/v1/ssh')).statusCode).toBe(401);
    const result = await app.inject({ url: '/v1/ssh', headers: { authorization: 'Bearer valid' } });
    expect(result.json()).toEqual(empty);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(service.snapshot).toHaveBeenCalledWith(userId);
    const noScope = await setup([]);
    expect(
      (await noScope.app.inject({ url: '/v1/ssh', headers: { authorization: 'Bearer valid' } }))
        .statusCode,
    ).toBe(403);
    expect(noScope.service.snapshot).not.toHaveBeenCalled();
  });
  it('honors current service gate and does not expose raw errors or credentials', async () => {
    const { app, service } = await setup();
    vi.mocked(service.snapshot).mockRejectedValueOnce(
      new SshError('skill_disabled', 'Skill spenta.', 403),
    );
    expect(
      (await app.inject({ url: '/v1/ssh', headers: { authorization: 'Bearer valid' } })).statusCode,
    ).toBe(403);
    vi.mocked(service.providerSave).mockRejectedValueOnce(new Error('password=synthetic-secret'));
    const result = await app.inject({
      method: 'PUT',
      url: '/v1/ssh/providers/vultr',
      headers: { authorization: 'Bearer valid' },
      payload: { apiKey: 'synthetic-secret-value' },
    });
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('synthetic-secret');
  });
  it('approval endpoint accepts only empty bodies, never a command or owner override', async () => {
    const { app, service } = await setup();
    const result = await app.inject({
      method: 'POST',
      url: `/v1/ssh/operations/${randomUUID()}/approve`,
      headers: { authorization: 'Bearer valid' },
      payload: { command: 'rm -rf /', userId: randomUUID() },
    });
    expect(result.statusCode).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();
  });
  it('exports no execute/approve tool and fails closed for a cheaper model or missing chat scope', async () => {
    const { service } = await setup();
    const tools = createSshTools(service);
    expect(tools.map((t) => t.id)).toEqual([
      'ssh_inventory',
      'ssh_diagnose',
      'ssh_investigate',
      'ssh_plan',
      'ssh_operation',
    ]);
    const investigation = tools.find((t) => t.id === 'ssh_investigate');
    if (!investigation) throw new Error('investigation');
    expect(
      await investigation.execute({ domain: 'example.it' }, {
        userId,
        modelClass: 'standard',
        scopes: ['chat'],
      } as never),
    ).toMatchObject({ error: 'advanced_model_required' });
    expect(
      await investigation.execute({ domain: 'example.it' }, {
        userId,
        modelClass: 'heavy',
        scopes: [],
      } as never),
    ).toMatchObject({ error: 'scope_required' });
    const inventory = tools[0];
    if (!inventory) throw new Error('inventory');
    expect(
      await inventory.execute({}, { userId, modelClass: 'standard', scopes: ['chat'] } as never),
    ).toMatchObject({ error: 'advanced_model_required' });
    expect(
      await inventory.execute({}, { userId, modelClass: 'heavy', scopes: [] } as never),
    ).toMatchObject({ error: 'scope_required' });
    expect(service.snapshot).not.toHaveBeenCalled();
    expect(
      await inventory.execute({}, { userId, modelClass: 'heavy', scopes: ['chat'] } as never),
    ).toMatchObject({
      ...empty,
      totals: { servers: 0, sites: 0 },
      pagination: { nextOffset: null },
    });
  });
});
