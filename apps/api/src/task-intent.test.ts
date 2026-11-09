import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from './auth.js';
import { taskIntentRoutes } from './routes/task-intent.js';
import { TaskIntentInput, type TaskIntentResolver, validateTaskIntent } from './task-intent.js';

const a = randomUUID(),
  b = randomUUID();
const input = { text: 'Siamo in quattro', tasks: [{ id: a, title: 'Prepara una cena' }] };
const auth: AuthContext = {
  userId: randomUUID(),
  apiKeyId: randomUUID(),
  scopes: ['chat'],
  role: 'owner',
  companionName: 'Ernie',
  settings: {},
};
describe('task intent boundary', () => {
  it('accepts only known targets, standalone new tasks and high confidence', () => {
    const decision = { kind: 'steer', targetId: a, confidence: 0.98, sharedResources: false };
    expect(validateTaskIntent(decision, input).kind).toBe('steer');
    for (const override of [
      { targetId: b },
      { confidence: 0.8 },
      { sharedResources: true },
      { kind: 'new' },
    ])
      expect(validateTaskIntent({ ...decision, ...override }, input).kind).toBe('ask');
    expect(validateTaskIntent({ ...decision, kind: 'new', targetId: null }, input).kind).toBe(
      'new',
    );
    expect(validateTaskIntent({ ...decision, instruction: 'execute' }, input).kind).toBe('ask');
  });
  it('rejects duplicate IDs, excess tasks and oversized input', () => {
    expect(
      TaskIntentInput.safeParse({ ...input, tasks: [input.tasks[0], input.tasks[0]] }).success,
    ).toBe(false);
    expect(TaskIntentInput.safeParse({ ...input, text: 'x'.repeat(4001) }).success).toBe(false);
    expect(TaskIntentInput.safeParse({ ...input, tasks: [] }).success).toBe(false);
  });
  async function setup(
    context: AuthContext | null = auth,
    resolver: TaskIntentResolver = async () => ({
      kind: 'new' as const,
      targetId: null,
      confidence: 0.98,
      sharedResources: false,
    }),
  ) {
    const app = Fastify();
    const resolve = vi.fn(resolver);
    await taskIntentRoutes(app, {
      authenticator: { authenticate: async () => context },
      allowedOrigins: [],
      resolve,
    });
    return { app, resolve };
  }
  it('denies unauthenticated, non-chat and disabled accounts before classification', async () => {
    for (const context of [
      null,
      { ...auth, scopes: [] },
      { ...auth, settings: { killSwitch: true } },
    ]) {
      const { app, resolve } = await setup(context);
      try {
        const res = await app.inject({ method: 'POST', url: '/v1/tasks/resolve', payload: input });
        expect([401, 403]).toContain(res.statusCode);
        expect(resolve).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it('uses authenticated identity, does not persist text, limits requests per user', async () => {
    const { app, resolve } = await setup();
    try {
      for (let i = 0; i < 13; i++) {
        const res = await app.inject({ method: 'POST', url: '/v1/tasks/resolve', payload: input });
        expect(res.json().kind).toBe(i < 12 ? 'new' : 'ask');
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect(resolve).toHaveBeenCalledTimes(12);
      expect(resolve.mock.calls[0]?.[0]).toBe(auth.userId);
    } finally {
      await app.close();
    }
  });
  it('falls back to choices on provider failure without exposing private errors', async () => {
    const { app } = await setup(
      auth,
      vi.fn(async () => {
        throw new Error('private prompt, secret');
      }),
    );
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/tasks/resolve', payload: input });
      expect(res.statusCode).toBe(200);
      expect(res.json().kind).toBe('ask');
      expect(res.body).not.toContain('private');
    } finally {
      await app.close();
    }
  });
  it('does not start another classifier for the same user while one is unresolved', async () => {
    let release!: (v: {
      kind: 'new';
      targetId: null;
      confidence: number;
      sharedResources: boolean;
    }) => void;
    const pending = new Promise<{
      kind: 'new';
      targetId: null;
      confidence: number;
      sharedResources: boolean;
    }>((r) => {
      release = r;
    });
    const resolve = vi.fn(() => pending);
    const { app } = await setup(auth, resolve);
    try {
      const first = app.inject({ method: 'POST', url: '/v1/tasks/resolve', payload: input });
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      const second = await app.inject({ method: 'POST', url: '/v1/tasks/resolve', payload: input });
      expect(second.json().kind).toBe('ask');
      release({ kind: 'new', targetId: null, confidence: 1, sharedResources: false });
      expect((await first).json().kind).toBe('new');
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
