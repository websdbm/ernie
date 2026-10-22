import { randomUUID } from 'node:crypto';
import { createEvent } from '@ernie/protocol';
import { describe, expect, it } from 'vitest';
import {
  ClientPerformanceBatch,
  type PerformanceObservation,
  ServerTurnTrace,
  summarizePerformance,
  timingSummary,
} from './performance.js';

const sessionId = randomUUID();
const requestId = randomUUID();
const sample = (extra: Partial<PerformanceObservation> = {}): PerformanceObservation => ({
  sessionId,
  requestId,
  source: 'ios',
  appVersion: '91',
  inputMode: 'text',
  outcome: 'completed',
  reconnected: false,
  metrics: { firstContentMs: 100, completedMs: 200 },
  ...extra,
});
describe('misure performance', () => {
  it('rifiuta testi, origine server, valori negativi e tempi incoerenti dal client', () => {
    for (const observation of [
      { ...sample(), text: 'privato' },
      sample({ source: 'server' }),
      sample({ metrics: { completedMs: -1 } }),
      sample({ metrics: { completedMs: 10, firstContentMs: 20 } }),
      sample({ metrics: {} }),
      sample({ metrics: { completedMs: 10, firstSpeechMs: 50, speechEndedMs: 40 } }),
      sample({ metrics: { completedMs: Number.NaN } }),
    ])
      expect(ClientPerformanceBatch.safeParse({ observations: [observation] }).success).toBe(false);
    expect(
      ClientPerformanceBatch.safeParse({
        observations: [
          sample({ metrics: { completedMs: 10, firstSpeechMs: 100, speechEndedMs: 150 } }),
        ],
      }).success,
    ).toBe(true);
  });
  it('non converte campioni mancanti in zero e separa dispositivi, build ed errori', () => {
    expect(timingSummary([])).toEqual({ samples: 0, p50Ms: null, p95Ms: null });
    expect(timingSummary([1, 2, 3, 4, 5])).toEqual({ samples: 5, p50Ms: 3, p95Ms: 5 });
    const report = summarizePerformance([
      sample(),
      sample({ outcome: 'error', metrics: { completedMs: 10 } }),
      sample({ reconnected: true, metrics: { completedMs: 30_000 } }),
      sample({ source: 'ios_simulator' }),
      sample({ appVersion: '90' }),
    ]);
    expect(report).toHaveLength(3);
    expect(report[0]).toMatchObject({
      total: 3,
      completed: 2,
      errors: 1,
      reconnected: 1,
      cleanSamples: 1,
      timings: {
        completedMs: { samples: 1, p50Ms: 200, p95Ms: 200 },
        firstSpeechMs: { samples: 0, p50Ms: null, p95Ms: null },
      },
    });
  });
  it('ignora spinner, tool status, altro turno e duplicati; termina prima del lavoro post-risposta', () => {
    let now = 0;
    const trace = new ServerTurnTrace(sessionId, requestId, 'text', 0, () => now);
    const event = (
      type: 'assistant.started' | 'assistant.text.delta' | 'assistant.completed',
      payload: object,
      other = requestId,
    ) => createEvent(type, payload as never, { sessionId, correlationId: other, seq: 0 });
    now = 10;
    expect(trace.observe(event('assistant.started', { route: 'llm' }))).toBeNull();
    now = 20;
    expect(
      trace.observe(event('assistant.text.delta', { delta: 'altro' }, randomUUID())),
    ).toBeNull();
    now = 30;
    expect(trace.observe(event('assistant.text.delta', { delta: '  ' }))).toBeNull();
    now = 90;
    trace.observe(event('assistant.text.delta', { delta: 'Ciao' }));
    now = 200;
    const result = trace.observe(event('assistant.completed', { finishReason: 'stop' }));
    expect(result).toMatchObject({
      source: 'server',
      metrics: { firstContentMs: 90, completedMs: 200 },
    });
    now = 5000;
    expect(trace.observe(event('assistant.completed', { finishReason: 'stop' }))).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Ciao');
  });
  it('segna riconnessioni e conserva errori senza inventare una prima risposta', () => {
    const trace = new ServerTurnTrace(sessionId, requestId, 'voice', 0, () => 450);
    trace.reconnect();
    const result = trace.observe(
      createEvent(
        'error',
        { code: 'x', message: 'contenuto privato', retryable: true },
        { sessionId, correlationId: requestId, seq: 0 },
      ),
    );
    expect(result).toMatchObject({
      outcome: 'error',
      reconnected: true,
      metrics: { completedMs: 450 },
    });
    expect(result?.metrics.firstContentMs).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('privato');
  });
  it.each(['error', 'cancelled'] as const)(
    'mantiene il terminale %s anche in assistant.completed',
    (finishReason) => {
      const trace = new ServerTurnTrace(sessionId, requestId, 'text', 0, () => 50);
      expect(
        trace.observe(
          createEvent(
            'assistant.completed',
            { finishReason },
            { sessionId, correlationId: requestId, seq: 0 },
          ),
        )?.outcome,
      ).toBe(finishReason);
    },
  );
});
