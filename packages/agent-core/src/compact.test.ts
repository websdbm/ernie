import { describe, expect, it } from 'vitest';
import {
  compactPrompt,
  createToolResultCompactor,
  currentTurnToolCallIds,
  isErrorOutput,
  type ModelPrompt,
  placeholder,
} from './compact.js';

const big = (seed: string) => ({ page: { content: `${seed} `.repeat(200) } });
const call = (id: string, toolName: string) => ({
  type: 'tool-call',
  toolCallId: id,
  toolName,
  input: { q: id },
});
const result = (id: string, toolName: string, value: unknown, type = 'json') => ({
  type: 'tool-result',
  toolCallId: id,
  toolName,
  output: { type, value },
});

/** Cronologia: due ricerche web grandi, una memoria, un errore, un risultato piccolo; poi il turno corrente. */
const prompt: ModelPrompt = [
  { role: 'system', content: 'Sei Ernie.' },
  { role: 'user', content: [{ type: 'text', text: 'cerca i Sumeri' }] },
  { role: 'assistant', content: [call('c1', 'web_search')] },
  { role: 'tool', content: [result('c1', 'web_search', big('sumeri'))] },
  { role: 'assistant', content: [call('c2', 'web_fetch'), call('c3', 'memory_search')] },
  {
    role: 'tool',
    content: [
      result('c2', 'web_fetch', big('uruk')),
      result('c3', 'memory_search', { memories: 'x'.repeat(900) }),
    ],
  },
  { role: 'assistant', content: [call('c4', 'web_fetch'), call('c5', 'get_time')] },
  {
    role: 'tool',
    content: [
      result('c4', 'web_fetch', { error: 'timeout', detail: 'y'.repeat(900) }),
      result('c5', 'get_time', { now: '2026-10-12' }),
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Ecco i Sumeri…' }] },
  { role: 'user', content: [{ type: 'text', text: 'e la scrittura?' }] },
  { role: 'assistant', content: [call('c6', 'web_search')] },
  { role: 'tool', content: [result('c6', 'web_search', big('cuneiforme'))] },
];

const outputs = (p: ModelPrompt) =>
  Object.fromEntries(
    p.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; toolCallId?: string; output?: { value: unknown } }>)
            .filter((x) => x.type === 'tool-result')
            .map((x) => [x.toolCallId as string, x.output?.value])
        : [],
    ),
  );

describe('compactPrompt', () => {
  it('sostituisce i risultati vecchi e grandi; conserva turno corrente, recenti, memoria, errori e piccoli', () => {
    const { prompt: out, stats } = compactPrompt(prompt, new Set(['c6']), { keepRecent: 0 });
    const o = outputs(out);
    expect(o.c1).toBe(placeholder('web_search', JSON.stringify(big('sumeri')).length));
    expect(o.c2).toBe(placeholder('web_fetch', JSON.stringify(big('uruk')).length));
    expect(o.c3).toEqual({ memories: 'x'.repeat(900) }); // protetto
    expect(o.c4).toMatchObject({ error: 'timeout' }); // errore
    expect(o.c5).toEqual({ now: '2026-10-12' }); // piccolo
    expect(o.c6).toEqual(big('cuneiforme')); // turno corrente
    expect(stats).toEqual({
      compacted: 2,
      removedChars: JSON.stringify(big('sumeri')).length + JSON.stringify(big('uruk')).length,
      toolResults: 6,
    });
    // Le chiamate restano intatte e il prompt originale non è stato mutato.
    expect((out[2] as { content: unknown[] }).content[0]).toEqual(call('c1', 'web_search'));
    expect(outputs(prompt).c1).toEqual(big('sumeri'));
  });

  it('keepRecent tiene interi gli ultimi risultati della cronologia (non del turno corrente)', () => {
    const { prompt: out, stats } = compactPrompt(prompt, new Set(['c6']), { keepRecent: 4 });
    // Cronologia: c1 c2 c3 c4 c5 → gli ultimi 4 (c2..c5) restano; solo c1 si compatta.
    const o = outputs(out);
    expect(o.c2).toEqual(big('uruk'));
    expect(typeof o.c1).toBe('string');
    expect(stats.compacted).toBe(1);
  });

  it('senza nulla da compattare restituisce lo stesso array', () => {
    const { prompt: out, stats } = compactPrompt(prompt, new Set(['c6']), { minChars: 100_000 });
    expect(out).toBe(prompt);
    expect(stats.compacted).toBe(0);
  });

  it('isErrorOutput riconosce gli errori del provider e quelli strutturati di Ernie', () => {
    expect(isErrorOutput({ type: 'error-text', value: 'boom' })).toBe(true);
    expect(isErrorOutput({ type: 'json', value: { error: 'denied' } })).toBe(true);
    expect(isErrorOutput({ type: 'json', value: { ok: true } })).toBe(false);
    expect(isErrorOutput({ type: 'text', value: 'error' })).toBe(false);
  });
});

describe('createToolResultCompactor', () => {
  it('conserva le chiamate del turno corrente lette dagli step e riporta le statistiche', () => {
    const seen: unknown[] = [];
    const proc = createToolResultCompactor({ keepRecent: 0, onCompacted: (s) => seen.push(s) });
    const steps = [{ toolCalls: [{ toolCallId: 'c6' }], toolResults: [{ toolCallId: 'c6' }] }];
    expect(currentTurnToolCallIds(steps)).toEqual(new Set(['c6']));
    const res = proc.processLLMRequest?.({
      prompt: prompt as never,
      steps: steps as never,
      stepNumber: 1,
    } as never) as { prompt: ModelPrompt } | undefined;
    expect(res?.prompt).toBeDefined();
    const o = outputs(res?.prompt ?? []);
    expect(o.c6).toEqual(big('cuneiforme'));
    expect(typeof o.c1).toBe('string');
    expect(seen).toEqual([
      { stepNumber: 1, compacted: 2, removedChars: expect.any(Number), toolResults: 6 },
    ]);
  });

  it('non restituisce nulla quando il prompt non cambia', () => {
    const proc = createToolResultCompactor({ minChars: 1_000_000 });
    expect(
      proc.processLLMRequest?.({ prompt: prompt as never, steps: [], stepNumber: 0 } as never),
    ).toBeUndefined();
  });
});
