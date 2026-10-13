/**
 * Riassunto della conversazione con Mastra vero (memoria in RAM, modello finto che registra il prompt):
 * i messaggi già riassunti spariscono dal prompt, il riassunto arriva subito dopo le istruzioni,
 * i messaggi più recenti e quello nuovo restano.
 */
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { describe, expect, it } from 'vitest';
import { createSessionSummaryProcessor } from './session-summary.js';

function recordingModel() {
  const prompts: unknown[] = [];
  return {
    prompts,
    model: {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('solo stream');
      },
      doStream: async (options: { prompt: unknown }) => {
        prompts.push(options.prompt);
        const parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'ok' },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } },
          },
        ];
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts) c.enqueue(p);
              c.close();
            },
          }),
        };
      },
    },
  };
}

const textOf = (m: { content: unknown }) =>
  typeof m.content === 'string'
    ? m.content
    : (m.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join(' ');

describe('riassunto della conversazione nel prompt', () => {
  it('toglie i messaggi riassunti e mette il riassunto dopo le istruzioni', async () => {
    const memory = new Memory({
      storage: new InMemoryStore(),
      options: { lastMessages: 34, semanticRecall: false, workingMemory: { enabled: false } },
    });
    const threadId = 'th-summary';
    const resourceId = 'u-summary';
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: 't',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
    });
    const base = Date.UTC(2026, 9, 13, 8, 0, 0);
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      threadId,
      resourceId,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      createdAt: new Date(base + i * 60_000),
      content: { format: 2 as const, parts: [{ type: 'text' as const, text: `messaggio ${i}` }] },
    }));
    await memory.saveMessages({ messages: msgs });
    const rec = recordingModel();
    let removed = -1;
    const agent = new Agent({
      id: 'a-summary',
      name: 'Ernie',
      instructions: 'ISTRUZIONI STABILI',
      model: rec.model as never,
      memory,
      inputProcessors: [
        createSessionSummaryProcessor(
          async () => ({
            text: 'RIASSUNTO: messaggi 0-3',
            coveredUntil: new Date(base + 3 * 60_000),
          }),
          (i) => {
            removed = i.removed;
          },
        ),
      ],
    });
    const s = await agent.stream('nuovo messaggio', {
      memory: { thread: threadId, resource: resourceId },
    });
    for await (const _ of s.fullStream) {
      /* consuma */
    }
    expect(removed).toBe(4);
    const prompt = rec.prompts[0] as Array<{ role: string; content: unknown }>;
    const systems = prompt.filter((m) => m.role === 'system').map(textOf);
    expect(systems[0]).toContain('ISTRUZIONI STABILI');
    expect(systems.at(-1)).toContain('RIASSUNTO: messaggi 0-3');
    const rest = prompt
      .filter((m) => m.role !== 'system')
      .map(textOf)
      .join(' | ');
    for (const i of [0, 1, 2, 3]) expect(rest).not.toContain(`messaggio ${i}`);
    for (const i of [4, 5, 6, 7]) expect(rest).toContain(`messaggio ${i}`);
    expect(rest).toContain('nuovo messaggio');
    // Il riassunto viene subito dopo le istruzioni, prima di qualunque messaggio della conversazione.
    const firstNonSystem = prompt.findIndex((m) => m.role !== 'system');
    const summaryIdx = prompt.findIndex(
      (m) => m.role === 'system' && textOf(m).includes('RIASSUNTO'),
    );
    expect(summaryIdx).toBeLessThan(firstNonSystem);
    // I messaggi tolti dal prompt restano salvati.
    const { messages } = await memory.recall({ threadId, resourceId, perPage: false });
    const ids = messages.map((m) => m.id);
    for (const i of [0, 1, 2, 3]) expect(ids).toContain(`m${i}`);
  });
});
