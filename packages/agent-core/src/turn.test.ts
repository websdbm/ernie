import type { LlmCallRecord } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import type { EventType, PayloadInputOf } from '@ernie/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { CompanionAgent } from './agent.js';
import { formatUserTurn, runTurn, turnContext } from './turn.js';

function fakeCompanion(
  chunks: Array<Record<string, unknown>>,
  opts: { delayMs?: number } = {},
): CompanionAgent {
  async function* gen() {
    for (const c of chunks) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      yield c;
    }
  }
  const agent = {
    stream: vi.fn(async () => ({ fullStream: gen() })),
  };
  return {
    agent: agent as unknown as CompanionAgent['agent'],
    provider: 'openrouter',
    prefixFingerprint: 'fp',
    profile: {
      modelClass: 'standard',
      modelId: 'anthropic/claude-sonnet-5.5',
      maxOutputTokens: 100,
      reasoning: 'low',
      maxSteps: 3,
    },
  };
}

const logger = createLogger({ level: 'silent', name: 't' });

function collector() {
  const events: Array<{ type: EventType; payload: unknown }> = [];
  const emit = <T extends EventType>(type: T, payload: PayloadInputOf<T>) => {
    events.push({ type, payload });
  };
  return { events, emit };
}

describe('runTurn', () => {
  it('traduce lo stream in eventi e registra una riga per step', async () => {
    const recorder = { record: vi.fn(async () => {}) };
    const companion = fakeCompanion([
      { type: 'text-delta', payload: { text: 'Ciao' } },
      { type: 'text-delta', payload: { text: ' Ale' } },
      {
        type: 'step-finish',
        payload: {
          output: { usage: { inputTokens: 100, outputTokens: 5 } },
          response: { id: 'gen-1' },
          stepResult: { reason: 'stop' },
          providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
        },
      },
      { type: 'finish', payload: { stepResult: { reason: 'stop' } } },
    ]);
    const { events, emit } = collector();
    const res = await runTurn({
      userId: 'u1',
      sessionId: 's1',
      correlationId: 'c1',
      text: 'ciao',
      inputMode: 'text',
      companion,
      abortSignal: new AbortController().signal,
      recorder,
      logger,
      emit,
    });
    expect(res.text).toBe('Ciao Ale');
    expect(res.llmCalls).toBe(1);
    expect(res.costUsd).toBeCloseTo(0.001);
    expect(events.map((e) => e.type)).toEqual([
      'assistant.started',
      'assistant.text.delta',
      'assistant.text.delta',
      'assistant.text.completed',
      'assistant.completed',
    ]);
    expect(recorder.record).toHaveBeenCalledTimes(1);
    const calls = recorder.record.mock.calls as unknown as Array<[LlmCallRecord]>;
    const call = calls[0]?.[0];
    if (!call) throw new Error('nessuna chiamata registrata');
    expect(call.generationId).toBe('gen-1');
    expect(call.usage.inputTokens).toBe(100);
    const completed = events.at(-1)?.payload as {
      usage: { llmCalls: number; costUsdActual: number };
    };
    expect(completed.usage.llmCalls).toBe(1);
  });

  it('emette assistant.cancelled quando il segnale viene abortito', async () => {
    const recorder = { record: vi.fn(async () => {}) };
    const companion = fakeCompanion(
      Array.from({ length: 10 }, (_, i) => ({ type: 'text-delta', payload: { text: `p${i} ` } })),
      { delayMs: 15 },
    );
    const ac = new AbortController();
    const { events, emit } = collector();
    setTimeout(() => ac.abort(), 40);
    const res = await runTurn({
      userId: 'u1',
      sessionId: 's1',
      correlationId: 'c2',
      text: 'racconta',
      inputMode: 'voice',
      companion,
      abortSignal: ac.signal,
      recorder,
      logger,
      emit,
    });
    expect(res.cancelled).toBe(true);
    expect(events.at(-1)?.type).toBe('assistant.cancelled');
    expect(events.some((e) => e.type === 'assistant.completed')).toBe(false);
  });

  it('un chunk error produce error + assistant.completed(error)', async () => {
    const recorder = { record: vi.fn(async () => {}) };
    const companion = fakeCompanion([{ type: 'error', payload: { error: new Error('boom') } }]);
    const { events, emit } = collector();
    const res = await runTurn({
      userId: 'u1',
      sessionId: 's1',
      correlationId: 'c3',
      text: 'x',
      inputMode: 'text',
      companion,
      abortSignal: new AbortController().signal,
      recorder,
      logger,
      emit,
    });
    expect(res.cancelled).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      'assistant.started',
      'error',
      'assistant.completed',
    ]);
  });

  it('formatUserTurn marca la modalità vocale fuori dal prefisso', () => {
    expect(formatUserTurn('ciao', 'voice')).toBe('[voce] ciao');
    expect(formatUserTurn('ciao', 'text')).toBe('ciao');
    expect(turnContext()).toBeUndefined();
    expect(turnContext('Memorie:\n- x')?.[0]?.content).toContain('non scritto dall');
  });
});

describe('runTurn: loop e decisione', () => {
  it('interrompe il turno quando la stessa chiamata tool si ripete', async () => {
    const recorder = { record: vi.fn(async () => {}) };
    const repeated = Array.from({ length: 6 }, () => ({
      type: 'tool-call',
      payload: { toolCallId: 'c', toolName: 'web_search', args: { q: 'x' } },
    }));
    const companion = fakeCompanion(repeated, { delayMs: 1 });
    const { events, emit } = collector();
    const res = await runTurn({
      userId: 'u1',
      sessionId: 's1',
      correlationId: 'c4',
      text: 'cerca',
      inputMode: 'text',
      companion,
      abortSignal: new AbortController().signal,
      recorder,
      logger,
      emit,
    });
    expect(res.loopDetected).toBe(true);
    const err = events.find((e) => e.type === 'error')?.payload as { code: string };
    expect(err.code).toBe('loop_detected');
    expect(events.at(-1)?.type).toBe('assistant.completed');
  });

  it("riporta rotta, costo e token del router nell'evento finale", async () => {
    const recorder = { record: vi.fn(async () => {}) };
    const companion = fakeCompanion([
      { type: 'text-delta', payload: { text: 'ok' } },
      {
        type: 'step-finish',
        payload: {
          output: { usage: { inputTokens: 10, outputTokens: 1 } },
          response: { id: 'g' },
          stepResult: { reason: 'stop' },
          providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
        },
      },
      { type: 'finish', payload: { stepResult: { reason: 'stop' } } },
    ]);
    const { events, emit } = collector();
    await runTurn({
      userId: 'u1',
      sessionId: 's1',
      correlationId: 'c5',
      text: 'x',
      inputMode: 'text',
      companion,
      decision: {
        route: 'llm',
        modelClass: 'standard',
        source: 'jev',
        costUsd: 0.00004,
        inputTokens: 900,
      },
      abortSignal: new AbortController().signal,
      recorder,
      logger,
      emit,
    });
    const completed = events.at(-1)?.payload as {
      usage: { routerTokens: number; costUsdActual: number };
    };
    expect(completed.usage.routerTokens).toBe(900);
    expect(completed.usage.costUsdActual).toBeCloseTo(0.00204, 6);
  });
});

describe('cancellation before provider start', () => {
  it('never contacts the model for an already cancelled turn', async () => {
    const companion = fakeCompanion([]),
      { events, emit } = collector();
    const result = await runTurn({
      userId: 'u',
      sessionId: 's',
      correlationId: 'c',
      text: 'ciao',
      inputMode: 'text',
      companion,
      abortSignal: AbortSignal.abort(),
      recorder: { record: vi.fn() },
      logger,
      emit,
    });
    expect(companion.agent.stream).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['assistant.cancelled']);
  });
});

it('spiega il limite temporaneo del provider e non mostra soltanto turno incompleto', async () => {
  const companion = fakeCompanion([
    {
      type: 'error',
      payload: {
        error: Object.assign(new Error('request denied'), {
          statusCode: 402,
          responseBody: JSON.stringify({
            error: { metadata: { reason: 'in_flight_budget_exhausted' } },
          }),
        }),
      },
    },
  ]);
  const { events, emit } = collector();
  await runTurn({
    userId: 'u1',
    sessionId: 's1',
    correlationId: 'c-limit',
    text: 'Riassumi il video',
    inputMode: 'text',
    companion,
    abortSignal: new AbortController().signal,
    recorder: { record: vi.fn(async () => {}) },
    logger,
    emit,
  });
  expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({
    code: 'provider_busy',
    message: expect.stringMatching(/temporaneamente/),
    retryable: true,
  });
  expect(companion.agent.stream).toHaveBeenCalledTimes(1);
});
