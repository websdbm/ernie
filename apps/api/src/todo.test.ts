import { randomUUID } from 'node:crypto';
import { TodoList } from '@ernie/protocol';
import { type TodoRepository, TodoValidationError, TodoVersionConflictError } from '@ernie/tools';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { todoRoutes } from './routes/todo.js';

const a = randomUUID(),
  b = randomUUID(),
  id = randomUUID();
const draft = {
  id,
  name: 'Oggi',
  mode: 'scheduled',
  day: '2026-10-19',
  timezone: 'Europe/Rome',
  items: [],
};
const saved = TodoList.parse({ ...draft, revision: 1, updatedAt: new Date().toISOString() });
const apps: ReturnType<typeof Fastify>[] = [];
async function setup(enabled = true, scope = true) {
  const app = Fastify();
  apps.push(app);
  const repo: TodoRepository = {
    list: vi.fn(async () => [saved]),
    get: vi.fn(async (u) => (u === a ? saved : null)),
    save: vi.fn(async () => saved),
    history: vi.fn(async () => []),
  };
  const canUse = vi.fn(async () => enabled);
  await todoRoutes(app, {
    repo,
    canUse,
    allowedOrigins: [],
    authenticator: {
      authenticate: async (key) =>
        key === 'A' || key === 'B'
          ? {
              userId: key === 'A' ? a : b,
              apiKeyId: randomUUID(),
              scopes: scope ? ['chat'] : [],
              role: 'member',
              companionName: 'Ernie',
              settings: {},
            }
          : null,
    },
  });
  await app.ready();
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key = 'A') =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    });
  return { app, repo, canUse, request };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe('Todo REST ownership, gate and structured failures', () => {
  it('requires authentication, live activation and chat scope for reads and writes', async () => {
    const { request, repo } = await setup(false);
    expect((await request('GET', '/v1/todo/lists', undefined, 'invalid')).statusCode).toBe(401);
    expect((await request('GET', '/v1/todo/lists')).statusCode).toBe(403);
    expect((await request('POST', '/v1/todo/lists', draft)).statusCode).toBe(403);
    expect(repo.list).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    const noScope = await setup(true, false);
    expect((await noScope.request('GET', '/v1/todo/lists')).statusCode).toBe(403);
  });
  it('fails closed when effective settings cannot be loaded', async () => {
    const { request, canUse, repo } = await setup();
    canUse.mockRejectedValueOnce(new Error('unavailable'));
    expect((await request('GET', '/v1/todo/lists')).statusCode).toBe(403);
    expect(repo.list).not.toHaveBeenCalled();
  });
  it('uses canonical responses, authenticated owner and strict body shapes', async () => {
    const { request, repo } = await setup();
    const lists = await request('GET', '/v1/todo/lists?day=2026-10-19');
    expect(lists.json()).toEqual({ lists: [saved] });
    expect(lists.headers['cache-control']).toBe('no-store');
    expect(repo.list).toHaveBeenCalledWith(a, { day: '2026-10-19' });
    expect((await request('POST', '/v1/todo/lists', draft)).json()).toEqual({ list: saved });
    expect(repo.save).toHaveBeenCalledWith(a, draft);
    expect((await request('POST', '/v1/todo/lists', { ...draft, userId: b })).statusCode).toBe(400);
    expect(
      (await request('PUT', `/v1/todo/lists/${id}`, { ...draft, revision: 1 })).statusCode,
    ).toBe(400);
    const { id: _id, ...update } = draft;
    expect((await request('PUT', `/v1/todo/lists/${id}`, update)).statusCode).toBe(400);
    expect(
      (await request('PUT', `/v1/todo/lists/${id}`, { ...update, revision: 1 })).statusCode,
    ).toBe(200);
  });
  it('returns 404 for another owner’s ID, without save or existence disclosure', async () => {
    const { request, repo } = await setup();
    const { id: _id, ...body } = draft;
    expect((await request('GET', `/v1/todo/lists/${id}`, undefined, 'B')).statusCode).toBe(404);
    expect(
      (await request('PUT', `/v1/todo/lists/${id}`, { ...body, revision: 1 }, 'B')).statusCode,
    ).toBe(404);
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('returns actionable overlap details and stale revision status without overwriting', async () => {
    const { request, repo } = await setup();
    vi.mocked(repo.save).mockRejectedValueOnce(
      new TodoValidationError(
        'schedule_conflict',
        'Due attività si sovrappongono.',
        [{ code: 'overlap', message: 'Sposta la palestra.', itemIds: [randomUUID()] }],
        409,
      ),
    );
    const conflict = await request('POST', '/v1/todo/lists', draft);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: 'schedule_conflict',
      details: [{ code: 'overlap' }],
    });
    vi.mocked(repo.save).mockRejectedValueOnce(new TodoVersionConflictError());
    expect((await request('POST', '/v1/todo/lists', draft)).statusCode).toBe(409);
  });
});
