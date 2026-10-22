import { describe, expect, it } from 'vitest';
import type { AutomationQueue } from './queue.js';
import { automationBackoff, enqueueRun } from './queue.js';

describe('backoff dei retry', () => {
  it('cresce in modo esponenziale, con jitter, fino a un tetto di 10 minuti', () => {
    expect(automationBackoff(1, () => 0)).toBe(30_000);
    expect(automationBackoff(2, () => 0)).toBe(60_000);
    expect(automationBackoff(3, () => 0)).toBe(120_000);
    expect(automationBackoff(3, () => 0.5)).toBe(127_500);
    expect(automationBackoff(10, () => 0.9)).toBe(600_000);
  });
});

describe('enqueueRun', () => {
  it('chiavi evento distinte non collidono dopo la sanitizzazione', async () => {
    const jobs = new Map<string, unknown>();
    const queue = {
      getJob: async (id: string) => jobs.get(id) ?? null,
      add: async (_n: string, data: unknown, opts: { jobId: string }) => {
        jobs.set(opts.jobId, data);
        return { id: opts.jobId };
      },
    } as unknown as AutomationQueue;
    const data = {
      automationId: 'a',
      userId: 'u',
      scheduledAt: new Date().toISOString(),
      dedupeKey: 'event:receipt/a',
      triggerType: 'event' as const,
      depth: 0,
    };
    const first = await enqueueRun(queue, data);
    const second = await enqueueRun(queue, { ...data, dedupeKey: 'event:receipt_a' });
    expect(second.enqueued).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);
  });
  it('usa un jobId senza due punti (vincolo di BullMQ 6) e segnala i duplicati', async () => {
    const jobs = new Map<string, unknown>();
    const queue = {
      getJob: async (id: string) => jobs.get(id) ?? null,
      add: async (_n: string, data: unknown, opts: { jobId: string }) => {
        jobs.set(opts.jobId, data);
        return { id: opts.jobId };
      },
    } as unknown as AutomationQueue;
    const data = {
      automationId: '2b1d0d2e-0000-4000-8000-000000000000',
      userId: 'u',
      scheduledAt: '2026-10-17T08:00:00.000Z',
      dedupeKey: 'cron:2026-10-17T08:00:00.000Z',
      triggerType: 'cron' as const,
      depth: 0,
    };
    const first = await enqueueRun(queue, data);
    expect(first.enqueued).toBe(true);
    expect(first.jobId).not.toMatch(/:/);
    expect(first.jobId).toMatch(/^run_2b1d0d2e-0000-4000-8000-000000000000_[a-f0-9]{64}$/);
    const second = await enqueueRun(queue, data);
    expect(second).toEqual({ enqueued: false, jobId: first.jobId });
  });
});
