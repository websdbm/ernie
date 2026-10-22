import { randomUUID } from 'node:crypto';
import { loadConfig } from '@ernie/config';
import { createLogger } from '@ernie/observability';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from './auth.js';
import { buildServer } from './server.js';
import { createSpeechService, SPEECH_MODEL, speechBudget } from './speech.js';

const auth: AuthContext = {
  userId: randomUUID(),
  apiKeyId: randomUUID(),
  scopes: ['chat'],
  role: 'owner',
  companionName: 'Ernie',
  settings: {},
};
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]);
const ok = () =>
  new Response(mp3, {
    headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-example' },
  });
function setup(fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok())) {
  const budget = { assertWithinBudget: vi.fn().mockResolvedValue({ spentUsd: 0 }) };
  const recorder = { record: vi.fn().mockResolvedValue(undefined) };
  const options = {
    apiKey: 'secret-never-returned',
    enabled: true,
    timeoutMs: 1000,
    usdPerMillionBytes: 10,
    dailyBudgetUsd: 2,
    budget,
    recorder,
    fetch: fetcher,
    processAudio: vi.fn(async (audio: Buffer) => audio),
  };
  return { service: createSpeechService(options), options, budget, recorder, fetcher };
}
describe('Drama 3 speech', () => {
  it('uses fixed model and style, returns MP3 and records a byte-based estimate without inventing tokens', async () => {
    const { service, fetcher, recorder } = setup();
    expect(await service.synthesize(auth, 'Ciao, come stai?', 'warm')).toEqual(mp3);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe(SPEECH_MODEL);
    expect(request.instructions).toContain('Italian');
    expect(request.voice).toBeUndefined();
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        modelClass: 'tts',
        generationId: 'gen-example',
        estimatedCostUsd: expect.any(Number),
        usage: expect.objectContaining({
          inputTokens: 0,
          outputTokens: 0,
          costReportedUsd: undefined,
        }),
      }),
    );
  });
  it('retries transient failures once and accounts for both attempts', async () => {
    const { service, fetcher, recorder } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockResolvedValueOnce(ok()),
    );
    expect(await service.synthesize(auth, 'Ciao', 'calm')).toEqual(mp3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.record).toHaveBeenCalledTimes(2);
  });
  it('processes provider audio and never regenerates paid speech after a processing failure', async () => {
    const { service, options, fetcher, recorder } = setup();
    const louder = Buffer.concat([mp3, Buffer.from('processed')]);
    options.processAudio.mockResolvedValueOnce(louder);
    expect(await service.synthesize(auth, 'Ciao', 'warm')).toEqual(louder);
    fetcher.mockResolvedValueOnce(ok());
    options.processAudio.mockRejectedValueOnce(new Error('decoder unavailable'));
    await expect(service.synthesize(auth, 'Ciao', 'calm')).rejects.toMatchObject({
      code: 'audio_processing_failed',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ finishReason: 'stop' }),
    );
  });
  it('does not retry invalid credentials or malformed audio', async () => {
    for (const response of [
      new Response('secret error', { status: 401 }),
      new Response('html'),
      new Response('invalid', { headers: { 'content-type': 'audio/mpeg' } }),
    ]) {
      const { service, fetcher } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
      await expect(service.synthesize(auth, 'Ciao', 'warm')).rejects.toThrow(/vocale/);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('stops on cancellation and releases the per-user lock', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(ok());
    const { service } = setup(fetcher);
    const controller = new AbortController();
    const pending = service.synthesize(auth, 'Ciao', 'warm', controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await expect(service.synthesize(auth, 'Ciao', 'warm')).rejects.toMatchObject({
      statusCode: 429,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 503 });
    expect(await service.synthesize(auth, 'Ciao', 'warm')).toEqual(mp3);
  });
  it('bounds time and audio size instead of keeping a stuck generation alive', async () => {
    const hanging = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          });
        }),
    );
    const { options } = setup(hanging);
    await expect(
      createSpeechService({ ...options, timeoutMs: 20 }).synthesize(auth, 'Ciao', 'warm'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(hanging).toHaveBeenCalledOnce();
    const huge = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(Buffer.alloc(4_000_001), { headers: { 'content-type': 'audio/mpeg' } }),
        ),
    );
    await expect(huge.service.synthesize(auth, 'Ciao', 'warm')).rejects.toMatchObject({
      code: 'audio_too_large',
    });
    expect(huge.fetcher).toHaveBeenCalledOnce();
  });

  it('enforces remaining budget, emergency switch, text limit and enablement before calling provider', async () => {
    const { service, budget, fetcher, options } = setup();
    budget.assertWithinBudget.mockResolvedValue({ spentUsd: 1.99999 });
    await expect(service.synthesize(auth, 'Ciao', 'warm')).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    await expect(
      service.synthesize({ ...auth, settings: { killSwitch: true } }, 'Ciao', 'warm'),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.synthesize(auth, 'x'.repeat(2001), 'warm')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      createSpeechService({ ...options, enabled: false }).synthesize(auth, 'Ciao', 'warm'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(speechBudget({ ...auth, role: 'member', settings: { dailyBudgetUsd: 100 } }, 2)).toBe(2);
    expect(speechBudget({ ...auth, role: 'member', settings: { dailyBudgetUsd: 0 } }, 2)).toBe(2);
  });
  it('authenticates REST and rejects arbitrary models/instructions rather than exposing an unrestricted proxy', async () => {
    const { service, fetcher } = setup();
    const app = await buildServer({
      config: loadConfig({
        DATABASE_URL: 'postgres://x:x@localhost/x',
        REDIS_URL: 'redis://localhost',
      }),
      logger: createLogger({ name: 'speech-test', level: 'silent' }),
      checks: {},
      speech: {
        speech: service,
        allowedOrigins: [],
        authenticator: { authenticate: async (key) => (key === 'valid' ? auth : null) },
      },
    });
    try {
      const payload = { text: 'Ciao', style: 'warm' };
      expect((await app.inject({ method: 'POST', url: '/v1/speech', payload })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/speech',
            headers: { authorization: 'Bearer valid' },
            payload: { ...payload, model: 'other' },
          })
        ).statusCode,
      ).toBe(400);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/speech',
        headers: { authorization: 'Bearer valid' },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('audio/mpeg');
      expect(response.rawPayload).toEqual(mp3);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
