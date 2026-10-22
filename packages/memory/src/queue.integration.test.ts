import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processTurnMemory, recordTurnEpisode } from './episodes.js';
import { enqueueConsolidation, enqueueSessionSummary, enqueueTurnMemory } from './queue.js';

const url = process.env.REDIS_URL;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe.skipIf(!url)('coda memoria, Redis isolato', () => {
  it('post-turno accettato prima del worker, job univoco e retry dopo guasto senza perdere i figli', async () => {
    const parsed = new URL(url as string);
    const connection = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      password: decodeURIComponent(parsed.password),
      maxRetriesPerRequest: null,
    };
    const queue = new Queue(`memory-performance-${randomUUID()}`, { connection });
    cleanup.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const episode = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      requestId: randomUUID(),
      userText: `  test \n\t coda ${'a'.repeat(400)}   `,
      route: 'llm',
      modelClass: 'standard',
      outcome: 'completed' as const,
      costUsd: 0,
      llmCalls: 1,
      toolCalls: 0,
      latencyMs: 1,
    };
    const data = { episode, consolidationDelayMs: 0 };
    await Promise.all([enqueueTurnMemory(queue, data), enqueueTurnMemory(queue, data)]);
    expect(await queue.getWaitingCount()).toBe(1);
    const jobs = await queue.getWaiting();
    expect(jobs[0]?.opts.removeOnFail).toBe(false);
    const queuedText = jobs[0]?.data.episode.userText;
    expect(queuedText).toBe(episode.userText.replace(/\s+/g, ' ').trim().slice(0, 140));
    expect(queuedText).toHaveLength(140);
    let originalContent = '';
    await recordTurnEpisode(
      {
        remember: async (input: { content: string }) => {
          originalContent = input.content;
          return {};
        },
      } as never,
      episode,
    );
    // Primo passaggio simula un guasto transitorio di persistenza prima di salvare l'episodio.
    let attempts = 0;
    let recorded = 0;
    const repo = {
      remember: async (input: { content: string }) => {
        expect(input.content).toBe(originalContent);
        if (++attempts === 1) throw new Error('DB momentaneamente non disponibile');
        recorded++;
        return {};
      },
    } as never;
    const handled: string[] = [];
    const worker = new Worker(
      queue.name,
      async (job) => {
        if (job.name === 'turn-memory') await processTurnMemory(repo, queue, job.data);
        handled.push(job.name);
      },
      { connection, concurrency: 2 },
    );
    cleanup.push(() => worker.close());
    await vi.waitFor(() => expect(handled).toContain('turn-memory'), { timeout: 10_000 });
    expect(attempts).toBe(2);
    expect(recorded).toBe(1);
    await vi.waitFor(() => expect(handled).toContain('consolidate'));
    // Il riassunto mantiene il suo debounce ordinario di3secondi.
    expect(
      (await queue.getJobs(['delayed', 'waiting', 'active', 'completed'])).some(
        (job) => job.name === 'summarize',
      ),
    ).toBe(true);
    await enqueueTurnMemory(queue, data);
    expect(await queue.getWaitingCount()).toBe(0);
    expect(recorded).toBe(1);
  });

  it('retry dopo il primo figlio accodato mantiene una sola consolidazione e aggiunge il riassunto mancante', async () => {
    const parsed = new URL(url as string);
    const connection = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      password: decodeURIComponent(parsed.password),
      maxRetriesPerRequest: null,
    };
    const queue = new Queue(`memory-crash-${randomUUID()}`, { connection });
    cleanup.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const data = {
      episode: {
        userId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
        userText: 'crash test',
        route: 'llm',
        modelClass: 'standard',
        outcome: 'completed' as const,
        costUsd: 0,
        llmCalls: 1,
        toolCalls: 0,
        latencyMs: 1,
      },
      consolidationDelayMs: 60_000,
    };
    const add = queue.add.bind(queue);
    let failed = false;
    const spy = vi.spyOn(queue, 'add').mockImplementation(async (name, body, opts) => {
      if (name === 'summarize' && !failed) {
        failed = true;
        throw new Error('crash tra i figli');
      }
      return add(name, body, opts);
    });
    const repo = { remember: async () => ({}) } as never;
    await expect(processTurnMemory(repo, queue, data)).rejects.toThrow('crash tra i figli');
    expect((await queue.getDelayed()).map((job) => job.name)).toEqual(['consolidate']);
    await processTurnMemory(repo, queue, data);
    expect((await queue.getDelayed()).map((job) => job.name).sort()).toEqual([
      'consolidate',
      'summarize',
    ]);
    spy.mockRestore();
  });

  it('accorpa turni durante una run attiva ed esegue una sola coda dopo, senza sovrapposizione', async () => {
    const parsed = new URL(url as string);
    const connection = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      password: decodeURIComponent(parsed.password),
      maxRetriesPerRequest: null,
    };
    const queue = new Queue(`memory-review-${randomUUID()}`, { connection });
    cleanup.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    const worker = new Worker(
      queue.name,
      async (job) => {
        active++;
        maxActive = Math.max(maxActive, active);
        seen.push(job.data.sessionId);
        if (seen.length === 1) await gate;
        active--;
      },
      { connection, concurrency: 3 },
    );
    cleanup.push(async () => {
      release();
      await worker.close();
    });
    const data = { userId: randomUUID(), threadId: randomUUID(), sessionId: 'first' };
    await enqueueConsolidation(queue, data, 0);
    await vi.waitFor(() => expect(seen).toEqual(['first']));
    await enqueueConsolidation(queue, { ...data, sessionId: 'middle' }, 0);
    await enqueueConsolidation(queue, { ...data, sessionId: 'latest' }, 0);
    release();
    await vi.waitFor(() => expect(seen).toEqual(['first', 'latest']));
    expect(maxActive).toBe(1);
  });

  it.each(['consolidate', 'summarize'])(
    'un nuovo turno dopo %s completato nello stesso minuto non viene perso',
    async (kind) => {
      const parsed = new URL(url as string);
      const connection = {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        password: decodeURIComponent(parsed.password),
        maxRetriesPerRequest: null,
      };
      const queue = new Queue(`memory-review-${randomUUID()}`, { connection });
      cleanup.push(async () => {
        await queue.obliterate({ force: true });
        await queue.close();
      });
      let completed = 0;
      const worker = new Worker(
        queue.name,
        async () => {
          completed++;
        },
        { connection },
      );
      cleanup.push(() => worker.close());
      const data = { userId: randomUUID(), threadId: randomUUID(), sessionId: randomUUID() };
      const enqueue = () =>
        kind === 'consolidate'
          ? enqueueConsolidation(queue, data, 0)
          : enqueueSessionSummary(queue, data, 0);
      await enqueue();
      await vi.waitFor(() => expect(completed).toBe(1));
      await vi.waitFor(async () => expect(await queue.getCompletedCount()).toBe(1));
      await enqueue();
      await vi.waitFor(() => expect(completed).toBe(2));
    },
  );
});
