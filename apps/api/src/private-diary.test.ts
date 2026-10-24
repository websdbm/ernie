import { request as httpRequest } from 'node:http';
import { loadConfig } from '@ernie/config';
import { BudgetExceededError } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from './auth.js';
import {
  createPrivateDiaryService,
  type PrivateDiaryInput,
  PrivateDiaryRequest,
} from './private-diary.js';
import { buildServer } from './server.js';

const PRIVATE = 'DIARY_SYNTHETIC_PRIVATE_CANARY_629';
const auth: AuthContext = {
  userId: 'synthetic-user',
  apiKeyId: 'synthetic-key',
  scopes: ['chat'],
  role: 'member',
  companionName: 'Ernie',
  settings: {},
};
const input: PrivateDiaryInput = {
  consent: true,
  operation: 'entry',
  entries: [
    {
      id: 'e1',
      createdAt: '2026-10-24T10:00:00+02:00',
      timeZone: 'Europe/Rome',
      original: PRIVATE,
    },
  ],
};
const validResult = {
  normalized: 'Una pagina di prova corretta.',
  bullets: ['Un fatto presente nella pagina di prova.'],
};
function response(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: PRIVATE,
    model: PRIVATE,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validResult) } }],
    usage: { prompt_tokens: 15, completion_tokens: 20, cost: 0.001 },
    ...overrides,
  });
}
function fixture(settings: Record<string, unknown> = { skills: { diario_personale: true } }) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const recorder = { record: vi.fn().mockResolvedValue(undefined) };
  const budget = { assertWithinBudget: vi.fn().mockResolvedValue({ spentUsd: 0 }) };
  const loadSettings = vi.fn(async () => settings);
  const options = {
    apiKey: 'synthetic-provider-key',
    model: 'anthropic/claude-sonnet-5.5',
    loadSettings,
    dailyBudgetUsd: 2,
    budget,
    recorder,
    fetch: fetcher,
    timeoutMs: 5000,
  };
  return {
    service: createPrivateDiaryService(options),
    options,
    fetcher,
    recorder,
    budget,
    loadSettings,
  };
}

describe('diario personale: trasformatore senza memoria', () => {
  it('usa solo un provider ZDR senza fallback e registra esclusivamente metadati ammessi', async () => {
    const f = fixture();
    expect(await f.service.capabilities(auth)).toEqual({
      available: true,
      enabled: true,
      model: f.options.model,
    });
    const result = await f.service.transform(auth, input);
    expect(result).toEqual({ ...validResult, model: f.options.model });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const request = f.fetcher.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body));
    expect(payload.provider).toEqual({
      data_collection: 'deny',
      zdr: true,
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(payload).toMatchObject({
      tools: [],
      plugins: [],
      store: false,
      stream: false,
      model: f.options.model,
    });
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(JSON.parse(payload.messages[1].content).entries[0]).toEqual({
      createdAt: input.entries[0]?.createdAt,
      timeZone: 'Europe/Rome',
      original: PRIVATE,
    });
    expect(request?.redirect).toBe('error');
    expect(f.recorder.record).toHaveBeenCalledTimes(1);
    expect(f.recorder.record.mock.calls[0]?.[0]).toMatchObject({
      generationId: null,
      sessionId: null,
      model: f.options.model,
      usage: { inputTokens: 15, outputTokens: 20, costReportedUsd: 0.001 },
    });
    expect(JSON.stringify(f.recorder.record.mock.calls)).not.toContain(PRIVATE);
    expect(JSON.stringify(f.budget.assertWithinBudget.mock.calls)).not.toContain(PRIVATE);
  });
  it('rifiuta skill spenta, non disponibile, account limitato e kill switch prima del provider', async () => {
    for (const settings of [
      {},
      { skills: { diario_personale: true }, skillsAvailable: { diario_personale: false } },
      { skills: { diario_personale: true }, killSwitch: true },
    ]) {
      const f = fixture(settings);
      expect((await f.service.capabilities(auth)).enabled).toBe(false);
      await expect(f.service.transform(auth, input)).rejects.toMatchObject({ statusCode: 403 });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
    const f = fixture();
    await expect(f.service.transform({ ...auth, scopes: [] }, input)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('senza chiave o modello esplicito non dichiara disponibile il servizio', async () => {
    const f = fixture();
    for (const options of [
      { ...f.options, apiKey: '' },
      { ...f.options, model: 'openrouter/auto' },
      { ...f.options, model: 'anthropic/claude:online' },
    ]) {
      const service = createPrivateDiaryService(options);
      expect((await service.capabilities(auth)).available).toBe(false);
      await expect(service.transform(auth, input)).rejects.toMatchObject({ statusCode: 503 });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('richiede consenso esplicito e limita conteggio, testo totale, date, fuso e campi', () => {
    for (const candidate of [
      { ...input, consent: false },
      { ...input, consent: undefined },
      { ...input, extra: PRIVATE },
      { ...input, entries: [] },
      { ...input, entries: [{ ...input.entries[0], original: ' '.repeat(10) }] },
      { ...input, entries: [{ ...input.entries[0], timeZone: 'Not/AZone' }] },
      { ...input, entries: [{ ...input.entries[0], createdAt: 'ieri' }] },
      { ...input, entries: [{ ...input.entries[0], original: 'x'.repeat(60_001) }] },
      {
        ...input,
        operation: 'period',
        entries: Array.from({ length: 32 }, (_, i) => ({ ...input.entries[0], id: String(i) })),
      },
      { ...input, entries: [input.entries[0], { ...input.entries[0], id: 'e2' }] },
      { ...input, operation: 'period', entries: [input.entries[0], input.entries[0]] },
      {
        ...input,
        operation: 'period',
        entries: [
          { ...input.entries[0], original: 'x'.repeat(30_001) },
          { ...input.entries[0], id: 'e2', original: 'x'.repeat(30_000) },
        ],
      },
    ])
      expect(PrivateDiaryRequest.safeParse(candidate).success).toBe(false);
    expect(
      PrivateDiaryRequest.safeParse({
        ...input,
        operation: 'period',
        entries: Array.from({ length: 31 }, (_, i) => ({ ...input.entries[0], id: String(i) })),
      }).success,
    ).toBe(true);
  });
  it('non rifà la richiesta e non divulga errori del provider, JSON o schema', async () => {
    for (const mode of ['http', 'throw', 'json', 'schema', 'tool', 'large'] as const) {
      const f = fixture();
      f.fetcher.mockImplementation(async () => {
        if (mode === 'throw') throw new Error(PRIVATE);
        if (mode === 'http') return new Response(PRIVATE, { status: 503 });
        if (mode === 'json') return new Response(`{${PRIVATE}`);
        if (mode === 'large') return new Response(PRIVATE.repeat(20_000));
        return response({
          choices: [
            {
              finish_reason: mode === 'tool' ? 'tool_calls' : 'stop',
              message: {
                content: JSON.stringify({ normalized: PRIVATE, bullets: [], forbidden: PRIVATE }),
              },
            },
          ],
        });
      });
      const error = await f.service.transform(auth, input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(PRIVATE);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.recorder.record.mock.calls)).not.toContain(PRIVATE);
    }
  });
  it('interrompe la chiamata su timeout/disconnessione e libera lo slot', async () => {
    for (const cancelEarly of [true, false]) {
      const f = fixture();
      f.fetcher.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error(PRIVATE)), {
              once: true,
            });
          }),
      );
      const service = createPrivateDiaryService({
        ...f.options,
        timeoutMs: cancelEarly ? 5000 : 15,
      });
      const abort = new AbortController();
      const pending = service.transform(auth, input, abort.signal);
      const expected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
      if (cancelEarly) abort.abort();
      await expected;
      f.fetcher.mockImplementation(async () => response());
      await expect(service.transform(auth, input)).resolves.toMatchObject(validResult);
    }
  });
  it('limita i tentativi e rispetta il budget senza inviare contenuti', async () => {
    const f = fixture();
    f.budget.assertWithinBudget.mockRejectedValue(new BudgetExceededError(2, 2));
    await expect(f.service.transform(auth, input)).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.recorder.record).not.toHaveBeenCalled();
    f.budget.assertWithinBudget.mockResolvedValue({ spentUsd: 0 });
    for (let i = 0; i < 5; i++) await f.service.transform(auth, input);
    await expect(f.service.transform(auth, input)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });
  it('non avvia due elaborazioni simultanee dello stesso account', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        }),
    );
    const abort = new AbortController();
    const first = f.service.transform(auth, input, abort.signal);
    const expected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    await expect(f.service.transform(auth, input)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    abort.abort();
    await expected;
  });
});

describe('diario personale: confine HTTP senza log di contenuti', () => {
  const apps: Awaited<ReturnType<typeof buildServer>>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  async function make() {
    const f = fixture();
    const logs: string[] = [];
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost/unused',
      REDIS_URL: 'redis://localhost:6379',
    });
    const logger = createLogger({
      level: 'trace',
      name: 'private-diary-test',
      destination: {
        write: (line) => {
          logs.push(String(line));
        },
      },
    });
    const app = await buildServer({
      config,
      logger,
      checks: {},
      privateDiary: {
        allowedOrigins: [],
        authenticator: { authenticate: async (key) => (key === 'synthetic' ? auth : null) },
        service: f.service,
      },
    });
    apps.push(app);
    return { ...f, app, logs };
  }
  it('autentica, controlla consenso, non memorizza in cache e non registra testo o risposte', async () => {
    const f = await make();
    const headers = { authorization: 'Bearer synthetic', 'content-type': 'application/json' };
    expect(
      (await f.app.inject({ method: 'POST', url: '/v1/private-diary/transform', payload: input }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/private-diary/transform',
          headers,
          payload: { ...input, consent: false },
        })
      ).statusCode,
    ).toBe(400);
    const result = await f.app.inject({
      method: 'POST',
      url: `/v1/private-diary/transform?private=${PRIVATE}`,
      headers,
      payload: input,
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toEqual({ ...validResult, model: f.options.model });
    const capabilities = await f.app.inject({
      method: 'GET',
      url: '/v1/private-diary/capabilities',
      headers,
    });
    expect(capabilities.json()).toEqual({ available: true, enabled: true, model: f.options.model });
    expect(f.logs.join('\n')).not.toContain(PRIVATE);
    expect(f.logs.join('\n')).not.toContain(validResult.normalized);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('sanitizza JSON malformato, payload enorme e errori senza raggiungere il logger generale', async () => {
    const f = await make();
    const headers = { authorization: 'Bearer synthetic', 'content-type': 'application/json' };
    for (const payload of [
      `{"${PRIVATE}`,
      JSON.stringify({
        ...input,
        entries: [{ ...input.entries[0], original: PRIVATE.repeat(20_000) }],
      }),
    ]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/v1/private-diary/transform',
        headers,
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain(PRIVATE);
    }
    f.fetcher.mockRejectedValue(new Error(PRIVATE));
    const result = await f.app.inject({
      method: 'POST',
      url: '/v1/private-diary/transform',
      headers,
      payload: input,
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain(PRIVATE);
    expect(f.logs.join('\n')).not.toContain(PRIVATE);
  });
  it('la chiusura della connessione HTTP annulla davvero la chiamata al provider', async () => {
    const f = await make();
    const providerAborted = vi.fn();
    f.fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              providerAborted();
              reject(new Error(PRIVATE));
            },
            { once: true },
          );
        }),
    );
    const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const payload = JSON.stringify(input);
    const request = httpRequest(`${address}/v1/private-diary/transform`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    request.on('error', () => {});
    request.end(payload);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    request.destroy();
    await vi.waitFor(() => expect(providerAborted).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.recorder.record).toHaveBeenCalledTimes(1));
    expect(f.logs.join('\n')).not.toContain(PRIVATE);
    expect(JSON.stringify(f.recorder.record.mock.calls)).not.toContain(PRIVATE);
  });
});
