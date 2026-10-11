import { describe, expect, it } from 'vitest';
import { interpretChunk, mapFinishReason } from './chunks.js';

describe('interpretChunk', () => {
  it('mappa text-delta, tool-call/result e step-finish', () => {
    const started = new Map<string, number>();
    expect(interpretChunk({ type: 'text-delta', payload: { text: 'ciao' } }, started)).toEqual({
      kind: 'text',
      delta: 'ciao',
    });
    expect(interpretChunk({ type: 'text-delta', payload: { text: '' } }, started).kind).toBe(
      'ignore',
    );

    const call = interpretChunk(
      {
        type: 'tool-call',
        payload: { toolCallId: 'c1', toolName: 'get_time', args: { tz: 'Europe/Rome' } },
      },
      started,
      1_000,
    );
    expect(call).toEqual({
      kind: 'tool.started',
      payload: { toolCallId: 'c1', toolId: 'get_time', argsPreview: '{"tz":"Europe/Rome"}' },
    });

    const result = interpretChunk(
      {
        type: 'tool-result',
        payload: { toolCallId: 'c1', toolName: 'get_time', result: { iso: 'x' } },
      },
      started,
      1_250,
    );
    expect(result).toEqual({
      kind: 'tool.completed',
      payload: {
        toolCallId: 'c1',
        toolId: 'get_time',
        ok: true,
        durationMs: 250,
        resultPreview: '{"iso":"x"}',
      },
    });

    const err = interpretChunk(
      { type: 'tool-error', payload: { toolCallId: 'c2', toolName: 'web', error: 'timeout' } },
      started,
      5,
    );
    expect(err.kind).toBe('tool.completed');
    if (err.kind === 'tool.completed') {
      expect(err.payload.ok).toBe(false);
      expect(err.payload.error).toBe('timeout');
    }

    const step = interpretChunk(
      {
        type: 'step-finish',
        payload: {
          output: { usage: { inputTokens: 10 } },
          response: { id: 'gen-1' },
          stepResult: { reason: 'tool-calls' },
          providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
        },
      },
      started,
    );
    expect(step).toEqual({
      kind: 'step',
      usage: { inputTokens: 10 },
      providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
      responseId: 'gen-1',
      finishReason: 'tool-calls',
    });
    expect(
      interpretChunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } }, started),
    ).toEqual({ kind: 'finish', finishReason: 'stop' });
    expect(
      interpretChunk({ type: 'reasoning-delta', payload: { text: 'hmm' } }, started).kind,
    ).toBe('ignore');
  });

  it('tronca le anteprime lunghe', () => {
    const started = new Map<string, number>();
    const r = interpretChunk(
      { type: 'tool-call', payload: { toolCallId: 'c', toolName: 't', args: 'x'.repeat(1000) } },
      started,
    );
    if (r.kind === 'tool.started') expect(r.payload.argsPreview?.length).toBeLessThanOrEqual(302);
  });
});

describe('mapFinishReason', () => {
  it('traduce i valori Mastra', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('tool-calls')).toBe('tool');
    expect(mapFinishReason('error')).toBe('error');
    expect(mapFinishReason(undefined)).toBe('stop');
  });
});
