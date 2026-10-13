/**
 * Regressione (M9): l'ultimo `step-finish` di Mastra può arrivare con i campi di primo livello già
 * cumulativi (l'oggetto è condiviso con il chunk `finish`) quando chi legge lo stream è più lento del
 * produttore, come il turno che scrive su database tra un chunk e l'altro. `normalizeUsage` deve
 * restituire l'uso del singolo passo. Modello finto a due passi (tool → testo) con uso noto.
 */
import { normalizeUsage } from '@ernie/model-gateway';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { interpretChunk } from './chunks.js';

const usage = (input: number, read: number, write: number, out: number) => ({
  inputTokens: { total: input, noCache: input - read - write, cacheRead: read, cacheWrite: write },
  outputTokens: { total: out, text: out, reasoning: 0 },
});

function twoStepModel() {
  let call = 0;
  const steps = [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: '{"text":"x"}' },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: usage(100, 90, 6, 10),
      },
    ],
    [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'ok' },
      { type: 'text-end', id: 'a' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usage(120, 0, 0, 20),
      },
    ],
  ];
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('solo stream');
    },
    doStream: async () => {
      const parts = steps[Math.min(call++, steps.length - 1)] ?? [];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}

describe('uso per passo con consumatore lento', () => {
  it("l'ultimo passo non diventa cumulativo", async () => {
    const agent = new Agent({
      id: 'probe',
      name: 'probe',
      instructions: 'x',
      model: twoStepModel() as never,
      memory: new Memory({
        storage: new InMemoryStore(),
        options: { lastMessages: 20, semanticRecall: false, workingMemory: { enabled: false } },
      }),
      tools: {
        echo: createTool({
          id: 'echo',
          description: 'eco',
          inputSchema: z.object({ text: z.string() }),
          execute: async (i: { text: string }) => ({ text: i.text }),
        }),
      },
    });
    const stream = await agent.stream('ciao', {
      maxSteps: 4,
      memory: { thread: 'th-probe', resource: 'u-probe' },
    });
    const steps: ReturnType<typeof normalizeUsage>[] = [];
    const started = new Map<string, number>();
    for await (const chunk of stream.fullStream as AsyncIterable<{
      type: string;
      payload?: unknown;
    }>) {
      await new Promise((r) => setTimeout(r, 25)); // come le scritture su database del turno
      const s = interpretChunk(chunk, started);
      if (s.kind === 'step') steps.push(normalizeUsage(s.usage, s.providerMetadata));
    }
    expect(
      steps.map((s) => [s.inputTokens, s.cacheReadTokens, s.cacheWriteTokens, s.outputTokens]),
    ).toEqual([
      [100, 90, 6, 10],
      [120, 0, 0, 20],
    ]);
  });
});
