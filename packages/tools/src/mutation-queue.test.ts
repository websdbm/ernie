import { RunContext } from '@ernie/agent-core';
import { createLogger } from '@ernie/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { memoryToolCallRecorder } from './audit.js';
import { createGuardedTool, type ExecutorDeps } from './executor.js';
import { defineTool, type ToolContext, type ToolSpec } from './types.js';

const logger = createLogger({ level: 'silent', name: 'mutation-test' });
const base: ToolSpec = defineTool({
  id: 'write_test',
  version: '1',
  category: 'utility',
  description: 'test',
  risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});
const context = (userId: string, signal?: AbortSignal): ToolContext => ({
  userId,
  sessionId: `session-${Math.random()}`,
  requestId: `request-${Math.random()}`,
  scopes: ['chat'],
  run: new RunContext(userId, ['chat'], 0),
  ...(signal ? { signal } : {}),
});
const invoke = (spec: ToolSpec, deps: ExecutorDeps, ctx: ToolContext) =>
  createGuardedTool(spec, deps, { current: ctx }).execute?.({}, {} as never);
const dependencies = (): ExecutorDeps => ({
  policyRules: {},
  audit: memoryToolCallRecorder(),
  logger,
});
afterEach(() => vi.useRealTimers());

describe('account mutation serialization', () => {
  it('serializes separate sessions of one user, while reads and another user run in parallel', async () => {
    const deps = dependencies();
    let release: () => void = () => {};
    const firstWrite = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });
    const nextWrite = vi.fn(async () => ({ ok: true }));
    const first = invoke({ ...base, execute: firstWrite }, deps, context('a'));
    await vi.waitFor(() => expect(firstWrite).toHaveBeenCalledOnce());
    const second = invoke({ ...base, execute: nextWrite }, deps, context('a'));
    expect(
      await invoke({ ...base, risk: { ...base.risk, write: false } }, deps, context('a')),
    ).toEqual({ ok: true });
    expect(await invoke(base, deps, context('b'))).toEqual({ ok: true });
    expect(nextWrite).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(nextWrite).toHaveBeenCalledOnce();
  });

  it('holds the account lane after a timeout until the actual write settles, with no automatic retry', async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    let release: () => void = () => {};
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });
    const first = invoke(
      { ...base, timeoutMs: 20, retry: { attempts: 3, backoffMs: 1 }, execute },
      deps,
      context('a'),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ error: 'timeout', retryable: false });
    const nextWrite = vi.fn(async () => ({ ok: true }));
    const second = invoke({ ...base, timeoutMs: 500, execute: nextWrite }, deps, context('a'));
    await vi.advanceTimersByTimeAsync(30);
    expect(nextWrite).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    release();
    expect(await second).toEqual({ ok: true });
    expect(nextWrite).toHaveBeenCalledOnce();
  });

  it('never performs an operation that expired or was cancelled while waiting', async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    let release: () => void = () => {};
    const blocker = invoke(
      {
        ...base,
        execute: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ok: true };
        },
      },
      deps,
      context('a'),
    );
    await vi.advanceTimersByTimeAsync(1);
    const expiredWrite = vi.fn(async () => ({ ok: true }));
    const expired = invoke({ ...base, timeoutMs: 10, execute: expiredWrite }, deps, context('a'));
    const abortedWrite = vi.fn(async () => ({ ok: true }));
    const controller = new AbortController();
    const aborted = invoke(
      { ...base, execute: abortedWrite },
      deps,
      context('a', controller.signal),
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await expired).toMatchObject({ error: 'timeout', retryable: false });
    expect(await aborted).toMatchObject({ error: 'aborted', retryable: false });
    release();
    await blocker;
    await vi.advanceTimersByTimeAsync(1);
    expect(expiredWrite).not.toHaveBeenCalled();
    expect(abortedWrite).not.toHaveBeenCalled();
  });

  it('serializes external effects too, and an already aborted operation never starts', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({ ok: true }));
    expect(
      await invoke(
        { ...base, execute, risk: { ...base.risk, write: false, externalEffect: true } },
        deps,
        context('a', controller.signal),
      ),
    ).toMatchObject({ error: 'aborted' });
    expect(execute).not.toHaveBeenCalled();
    expect(await invoke(base, deps, context('a'))).toEqual({ ok: true });
  });
});
