import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIEmbedder } from './embeddings.js';

function failure(status: number, message: string, code = 'provider_error', headers = {}) {
  return new Response(JSON.stringify({ error: { message, code, type: code, param: null } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function success(count = 1, start?: number) {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, (_, index) => ({
        index,
        embedding: [start === undefined ? 0.25 : start + index, -0.5],
      })),
      usage: { prompt_tokens: count * 3, total_tokens: count * 3 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OpenAI embedding retries and per-instance circuit, using real SDK with fake fetch', () => {
  it.each([
    [429, 'You exceeded your current quota', 'insufficient_quota'],
    [
      429,
      'You have no credits remaining. Add credits to continue using the API.',
      'insufficient_credits',
    ],
    [401, 'Incorrect API key', 'invalid_api_key'],
    [403, 'Permission denied', 'permission_denied'],
    [402, 'Payment required', 'payment_required'],
  ])(
    'does not retry status %i / %s and fails subsequent calls without network',
    async (status, message, code) => {
      const fetch = vi.fn(async () => failure(status, message, code));
      vi.stubGlobal('fetch', fetch);
      const embedder = createOpenAIEmbedder('fake-test-key');
      await expect(embedder.embed(['synthetic'])).rejects.toThrow(message);
      for (let index = 0; index < 5; index++)
        await expect(embedder.embed(['synthetic'])).rejects.toThrow('temporarily unavailable');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await embedder.embed([])).toEqual({ vectors: [], tokens: 0 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('permits one probe after cooldown, rejects concurrent probes, then recovers the same provider', async () => {
    const fetch = vi.fn(async (_url?: unknown) =>
      failure(429, 'You have no credits remaining.', 'insufficient_quota'),
    );
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-test-key');
    await expect(embedder.embed(['first'])).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120_001);
    const next = deferred<Response>();
    fetch.mockImplementationOnce(() => next.promise);
    const probe = embedder.embed(['probe']);
    const concurrent = await Promise.allSettled(
      Array.from({ length: 10 }, () => embedder.embed(['concurrent'])),
    );
    expect(concurrent.every((result) => result.status === 'rejected')).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    next.resolve(success());
    expect(await probe).toEqual({ vectors: [[0.25, -0.5]], tokens: 3 });
    fetch.mockImplementation(async () => success());
    expect(await embedder.embed(['recovered'])).toEqual({ vectors: [[0.25, -0.5]], tokens: 3 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('api.openai.com/v1/embeddings');
  });

  it('reopens the circuit after a failed probe; separate instances remain independent', async () => {
    const fetch = vi.fn(async () => failure(429, 'insufficient_quota'));
    vi.stubGlobal('fetch', fetch);
    const first = createOpenAIEmbedder('fake-key-1');
    const other = createOpenAIEmbedder('fake-key-2');
    await expect(first.embed(['first'])).rejects.toThrow();
    await expect(other.embed(['independent'])).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120_001);
    await expect(first.embed(['probe'])).rejects.toThrow('insufficient_quota');
    await expect(first.embed(['still unavailable'])).rejects.toThrow('temporarily unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('never lets an older successful concurrent call reset a newer outage', async () => {
    const firstResponse = deferred<Response>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async () => failure(429, 'You have no credits remaining.'));
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-key');
    const pending = embedder.embed(['first']);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await expect(embedder.embed(['second'])).rejects.toThrow('no credits');
    firstResponse.resolve(success());
    await pending;
    await expect(embedder.embed(['third'])).rejects.toThrow('temporarily unavailable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a genuine temporary error at most once and opens a short circuit after exhaustion', async () => {
    const fetch = vi.fn(async () => failure(503, 'Service unavailable'));
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-key');
    const result = embedder.embed(['synthetic']).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(embedder.embed(['blocked'])).rejects.toThrow('temporarily unavailable');
    await vi.advanceTimersByTimeAsync(30_001);
    fetch.mockImplementation(async () => success());
    expect((await embedder.embed(['probe'])).vectors).toEqual([[0.25, -0.5]]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('respects Retry-After for true rate limiting, but does not wait past the total deadline', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        failure(429, 'Rate limit reached', 'rate_limit_exceeded', { 'retry-after': '1' }),
      )
      .mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-key');
    const pending = embedder.embed(['rate limited']);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect((await pending).tokens).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () =>
      failure(429, 'Rate limit reached', 'rate_limit_exceeded', { 'retry-after': '60' }),
    );
    await expect(embedder.embed(['long wait'])).rejects.toThrow('Rate limit');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(embedder.embed(['too early'])).rejects.toThrow('temporarily unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('bounds the entire call even when a provider ignores cancellation and opens a short circuit', async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-key');
    const pending = embedder.embed(['slow']).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    expect(signal?.aborted).toBe(true);
    await expect(embedder.embed(['blocked'])).rejects.toThrow('temporarily unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one eight-second deadline across the retry wait and the second attempt', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(503, 'temporary'))
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const pending = createOpenAIEmbedder('fake-key')
      .embed(['slow retry'])
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(501);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7499);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry or poison the circuit for invalid input', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure(400, 'Input too long'))
      .mockImplementation(async () => success());
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-key');
    await expect(embedder.embed(['bad'])).rejects.toThrow('Input too long');
    expect((await embedder.embed(['valid'])).tokens).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries only the failed SDK chunk, preserving successful chunks and vector ordering', async () => {
    const attempts = new Map<string, number>();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      const first = input[0] ?? '';
      const attempt = (attempts.get(first) ?? 0) + 1;
      attempts.set(first, attempt);
      if (first === 'text2048' && attempt === 1) return failure(503, 'temporary');
      return success(input.length, Number(first.replace('text', '')));
    });
    vi.stubGlobal('fetch', fetch);
    const embedder = createOpenAIEmbedder('fake-key');
    const pending = embedder.embed(Array.from({ length: 4097 }, (_, index) => `text${index}`));
    await vi.advanceTimersByTimeAsync(501);
    const result = await pending;
    expect(result.vectors).toHaveLength(4097);
    expect(result.vectors[0]).toEqual([0, -0.5]);
    expect(result.vectors[2048]).toEqual([2048, -0.5]);
    expect(result.vectors[4096]).toEqual([4096, -0.5]);
    expect(result.tokens).toBe(4097 * 3);
    expect([...attempts]).toEqual([
      ['text0', 1],
      ['text2048', 2],
      ['text4096', 1],
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
