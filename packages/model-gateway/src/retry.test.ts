import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelRetryDelayMs, retryModelCall, transientModelError } from './retry.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('retry della singola chiamata al modello', () => {
  it('ritenta due errori temporanei e mantiene il risultato del terzo tentativo', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ cause: { code: 'EAI_AGAIN' } })
      .mockResolvedValue('ok');
    const pending = retryModelCall(call);
    await vi.runAllTimersAsync();
    expect(await pending).toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });
  it('si ferma al terzo fallimento e non ritenta errori definitivi', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue({ statusCode: 429 });
    const pending = expect(retryModelCall(call)).rejects.toMatchObject({ statusCode: 429 });
    await vi.runAllTimersAsync();
    await pending;
    expect(call).toHaveBeenCalledTimes(3);
    for (const statusCode of [400, 401, 403, 404]) {
      const invalid = vi.fn().mockRejectedValue({ statusCode });
      await expect(retryModelCall(invalid)).rejects.toMatchObject({ statusCode });
      expect(invalid).toHaveBeenCalledTimes(1);
    }
  });
  it('Stop interrompe anche il backoff; errori di uno stream già aperto non rilanciano la chiamata', async () => {
    const ac = new AbortController();
    const call = vi.fn().mockRejectedValue({ statusCode: 503 });
    const pending = retryModelCall(call, ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeDefined();
    expect(call).toHaveBeenCalledTimes(1);
    expect(transientModelError(new DOMException('Stop', 'AbortError'))).toBe(false);
    const open = vi.fn(async () => ({
      stream: new ReadableStream({
        start(c) {
          c.error(new Error('connessione persa'));
        },
      }),
    }));
    const result = await retryModelCall(open);
    await expect(result.stream.getReader().read()).rejects.toThrow('connessione persa');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

const inFlight = (retryAfter = '120') => ({
  statusCode: 402,
  responseBody: JSON.stringify({
    error: {
      code: 402,
      metadata: {
        reason: 'in_flight_budget_exhausted',
        headers: { 'Retry-After': retryAfter },
      },
    },
  }),
});

describe('OpenRouter: credito riservato alle richieste in corso', () => {
  it('usa l’header HTTP anche con maiuscole diverse e supporta una data Retry-After', () => {
    expect(
      modelRetryDelayMs(
        {
          ...inFlight('1'),
          responseHeaders: { 'retry-after': '120' },
        },
        0,
      ),
    ).toBe(120_000);
    expect(
      modelRetryDelayMs(
        {
          statusCode: 429,
          responseHeaders: { 'Retry-After': 'Tue, 20 Oct 2026 18:00:10 GMT' },
        },
        0,
        Date.parse('2026-10-20T18:00:00Z'),
      ),
    ).toBe(10_000);
  });

  it('l’annullamento durante Retry-After non invia un altro tentativo', async () => {
    const ac = new AbortController();
    vi.mocked(delay).mockImplementationOnce(
      (_ms, _value, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), {
            once: true,
          });
        }),
    );
    const call = vi.fn().mockRejectedValue(inFlight());
    const pending = expect(retryModelCall(call, ac.signal)).rejects.toBeDefined();
    await vi.waitFor(() => expect(delay).toHaveBeenCalled());
    ac.abort();
    await pending;
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('ritenta il 402 temporaneo rispettando Retry-After, senza ripetere chiamate riuscite', async () => {
    const call = vi.fn().mockRejectedValueOnce(inFlight()).mockResolvedValue('riassunto');
    expect(await retryModelCall(call)).toBe('riassunto');
    expect(call).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(120_000, undefined, { signal: undefined });
  });
  it('non confonde un 402 senza credito con il limite temporaneo e non anticipa attese troppo lunghe', async () => {
    for (const error of [{ statusCode: 402 }, inFlight('3600')]) {
      const call = vi.fn().mockRejectedValue(error);
      await expect(retryModelCall(call)).rejects.toEqual(error);
      expect(call).toHaveBeenCalledTimes(1);
    }
    expect(transientModelError(inFlight())).toBe(true);
    expect(transientModelError({ statusCode: 402 })).toBe(false);
  });
});
