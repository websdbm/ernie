/**
 * Contratto con Mastra su cui conta il contesto del turno (memorie, avvisi, ora e posizione del telefono):
 * i messaggi passati in `context` arrivano al modello dopo la cronologia e prima del messaggio dell'utente
 * (il prefisso in cache non cambia), non vengono salvati nel thread e non si accumulano tra i turni.
 */
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { describe, expect, it } from 'vitest';
import { formatUserTurn, turnContext } from './turn.js';

type PromptMessage = { role: string; content: unknown };

function textModel(prompts: PromptMessage[][]) {
  const finish = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  };
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('solo stream');
    },
    doStream: async (opts: { prompt: PromptMessage[] }) => {
      prompts.push(opts.prompt);
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'a' },
        { type: 'text-delta', id: 'a', delta: 'ok' },
        { type: 'text-end', id: 'a' },
        finish,
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
  };
}

const textOf = (m: PromptMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : (m.content as { type: string; text?: string }[]).map((p) => p.text ?? '').join(' ');

describe('contesto del turno come messaggio context', () => {
  it('dopo la cronologia, non salvato, non accumulato', async () => {
    const prompts: PromptMessage[][] = [];
    const memory = new Memory({
      storage: new InMemoryStore(),
      options: { lastMessages: 20, semanticRecall: false, workingMemory: { enabled: false } },
    });
    const agent = new Agent({
      id: 'c',
      name: 'c',
      instructions: 'ISTRUZIONI',
      model: textModel(prompts) as never,
      memory,
    });
    for (const [i, ctx] of ['Posizione: Padova', 'Posizione: Venezia'].entries()) {
      const s = await agent.stream(formatUserTurn(`domanda ${i}`, 'text'), {
        context: turnContext(ctx) ?? [],
        memory: { thread: 'th', resource: 'u' },
      });
      for await (const _ of s.fullStream as AsyncIterable<unknown>) {
        /* consuma */
      }
    }
    const second = (prompts[1] ?? []).map(textOf);
    expect(second[0]).toBe('ISTRUZIONI');
    // Cronologia intatta (prefisso stabile), poi il contesto, poi la domanda.
    expect(second.slice(1, 3)).toEqual(['domanda 0', 'ok']);
    expect(second.at(-2)).toContain('Posizione: Venezia');
    expect(second.at(-1)).toBe('domanda 1');
    expect(second.join('|')).not.toContain('Padova');
    const saved = await memory.recall({ threadId: 'th', resourceId: 'u' });
    expect(JSON.stringify(saved.messages)).not.toContain('Posizione');
    expect(saved.messages).toHaveLength(4);
  });
});
