import { describe, expect, it, vi } from 'vitest';
import { createFirecrawlClient, createWebTools, sanitizeWebContent } from './builtins/web.js';
import type { WebContentSelection } from './builtins/web-content.js';
import { type ToolContext, ToolError } from './types.js';

const okSearch = {
  success: true,
  data: {
    web: [
      {
        url: 'https://a.example/x?utm_source=z',
        title: 'A',
        description: 'd',
        markdown: '# Titolo\n\n![img](http://i.png)\n\n[link](https://b.example/p?fbclid=1) testo',
      },
      { url: 'https://blocked.example/y', title: 'B', description: '', markdown: 'no' },
    ],
  },
  creditsUsed: 2,
};

describe('Firecrawl client', () => {
  it('ricerca: legge la forma documentata, applica i filtri di dominio e sanifica', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        query: 'carbonara',
        limit: 2,
        scrapeOptions: { formats: ['markdown'] },
      });
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fc-x');
      return new Response(JSON.stringify(okSearch), { status: 200 });
    });
    const client = createFirecrawlClient({
      apiKey: 'fc-x',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [tool] = createWebTools(client, {
      blockedDomains: ['blocked.example'],
      maxCharsPerResult: 500,
    });
    const out = (await tool?.execute(
      { query: 'carbonara', limit: 2 },
      { userId: 'u', sessionId: null, requestId: 'r', scopes: [], run: {} as never },
    )) as { results: Array<{ url: string; content: string }> };
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.url).toBe('https://a.example/x?utm_source=z');
    expect(out.results[0]?.content).toBe('# Titolo\n\nlink testo');
    expect(sanitizeWebContent('a\n\n\n\nb   \nc', 100)).toBe('a\n\nb\nc');
  });

  it('errori: 401 non è ritentabile, 503 lo è, forma inattesa è errore strutturato', async () => {
    const mk = (status: number, body = '{}') =>
      createFirecrawlClient({
        apiKey: 'k',
        fetch: (async () => new Response(body, { status })) as unknown as typeof fetch,
      });
    await expect(mk(401).search('q', 1, 100)).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    await expect(mk(503).search('q', 1, 100)).rejects.toMatchObject({
      code: 'upstream',
      retryable: true,
    });
    await expect(
      mk(200, '{"success":true,"data":{"nope":1}}').scrape('https://x.example', 100),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('web_fetch rifiuta domini non consentiti prima di chiamare la rete', async () => {
    const fetchMock = vi.fn();
    const [, fetchTool] = createWebTools(
      createFirecrawlClient({ apiKey: 'k', fetch: fetchMock as unknown as typeof fetch }),
      { allowedDomains: ['ok.example'] },
    );
    await expect(
      fetchTool?.execute(
        { url: 'https://evil.example/p' },
        { userId: 'u', sessionId: null, requestId: 'r', scopes: [], run: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'blocked_domain' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function context(userId = 'alice', signal?: AbortSignal) {
  return {
    userId,
    sessionId: null,
    requestId: 'r',
    scopes: [],
    run: {} as never,
    ...(signal ? { signal } : {}),
  };
}
function pageResponse(markdown = 'Contenuto della pagina', metadata: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: true, data: { markdown, metadata } }), {
    status: 200,
  });
}
interface TestPage {
  url: string;
  content: string;
  coverage: WebContentSelection['coverage'] & { scope: string };
  source: {
    requestedUrl: string;
    cache: string;
    retrievedAt: string;
    contentId: string;
    providerMaxAgeMs: number;
    warning: string | null;
  };
}
interface TestSource {
  url: string;
  status: string;
  page?: TestPage;
  error?: { code: string; retryable: boolean; message: string };
}
function setup(
  fetchMock: ReturnType<typeof vi.fn>,
  options: Parameters<typeof createWebTools>[1] = {},
) {
  const tools = createWebTools(
    createFirecrawlClient({ apiKey: 'test-only', fetch: fetchMock as unknown as typeof fetch }),
    options,
  );
  const tool = <T>(id: string) => {
    const found = tools.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Missing ${id}`);
    return { ...found, execute: found.execute as (input: unknown, ctx: ToolContext) => Promise<T> };
  };
  return {
    search: tool<{ results: TestPage[] }>('web_search'),
    read: tool<{ page: TestPage }>('web_fetch'),
    batch: tool<{ sources: TestSource[]; coverage: { returnedChars: number } }>('read_sources'),
  };
}

describe('web source coverage and provider contract', () => {
  it('selects late passages and serves later offsets from the same cached document', async () => {
    const full = `${'Introduzione generica. '.repeat(230)}\n\n## Riciclo\n\nIl riciclo richiede 14 giorni. ${'Ulteriori dettagli. '.repeat(80)}`;
    const fetchMock = vi.fn(async () =>
      pageResponse(full, {
        title: 'Fonte',
        url: 'https://site.example/final',
        sourceURL: 'https://site.example/a',
        statusCode: 200,
        language: 'it',
      }),
    );
    const { read } = setup(fetchMock);
    const first = await read.execute(
      { url: 'https://site.example/a', query: 'Quanto richiede il riciclo?' },
      context(),
    );
    expect(first.page.content).toContain('14 giorni');
    expect(first.page.coverage).toMatchObject({
      totalChars: sanitizeWebContent(full, Number.MAX_SAFE_INTEGER).length,
      selection: 'relevant',
      truncated: true,
      nextOffset: 0,
    });
    expect(first.page.source).toMatchObject({
      requestedUrl: 'https://site.example/a',
      cache: 'miss',
      httpStatus: 200,
      providerMaxAgeMs: 300000,
      language: 'it',
    });
    expect(first.page.url).toBe('https://site.example/final');
    const second = await read.execute(
      {
        url: 'https://site.example/a',
        offset: first.page.coverage.nextOffset,
        contentId: first.page.source.contentId,
      },
      context(),
    );
    expect(second.page.content).toBe(full.slice(0, 3000));
    expect(second.page.source.cache).toBe('hit');
    expect(second.page.source.retrievedAt).toBe(first.page.source.retrievedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read.outputSchema.safeParse(second).success).toBe(true);
  });

  it('maps only documented freshness/geography/language fields and preserves the old input', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        query: 'Novità',
        limit: 3,
        country: 'IT',
        tbs: 'qdr:w',
        scrapeOptions: {
          formats: ['markdown'],
          onlyMainContent: true,
          maxAge: 0,
          location: { country: 'IT', languages: ['it-IT'] },
        },
      });
      expect(body).not.toHaveProperty('lang');
      return new Response(JSON.stringify(okSearch));
    });
    const { search, read } = setup(fetchMock);
    expect(search.inputSchema.safeParse({ query: 'Novità' }).success).toBe(true);
    expect(read.inputSchema.safeParse({ url: 'https://a.example' }).success).toBe(true);
    const out = await search.execute(
      { query: 'Novità', freshness: 'week', refresh: true, language: 'it-IT', country: 'it' },
      context(),
    );
    expect(out.results[0]?.source.providerMaxAgeMs).toBe(0);
    expect(search.outputSchema.safeParse(out).success).toBe(true);
  });

  it('search primes page cache for follow-up reading, without treating a snippet as a page', async () => {
    const fetchMock = vi.fn(async (url) =>
      String(url).endsWith('/search')
        ? new Response(
            JSON.stringify({
              data: {
                web: [
                  { url: 'https://a.example', markdown: 'Full page' },
                  { url: 'https://b.example', description: 'Only a search snippet' },
                ],
              },
            }),
          )
        : pageResponse('New full scrape'),
    );
    const { search, read } = setup(fetchMock);
    const found = await search.execute({ query: 'page', limit: 2 }, context());
    expect(found.results[1]?.coverage.scope).toBe('search_snippet');
    expect((await read.execute({ url: 'https://a.example/' }, context())).page.source.cache).toBe(
      'hit',
    );
    expect((await read.execute({ url: 'https://b.example/' }, context())).page.source.cache).toBe(
      'miss',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refresh invalidates source offsets when the source changes', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.maxAge).toBe(n ? 0 : 300000);
      return pageResponse(n++ ? 'Nuova versione' : 'Versione precedente');
    });
    const { read } = setup(fetchMock);
    const first = await read.execute({ url: 'https://a.example' }, context());
    await expect(
      read.execute(
        {
          url: 'https://a.example',
          refresh: true,
          offset: 1,
          contentId: first.page.source.contentId,
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'source_changed', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('declares the retained-page limit instead of claiming full coverage', async () => {
    const fetchMock = vi.fn(async () => pageResponse('x'.repeat(210000)));
    const { read } = setup(fetchMock);
    const out = await read.execute({ url: 'https://a.example' }, context());
    expect(out.page.coverage).toMatchObject({
      totalChars: 210000,
      availableChars: 200000,
      storageTruncated: true,
      truncated: true,
      returnedChars: 3000,
    });
    await expect(
      read.execute({ url: 'https://a.example', offset: 200000 }, context()),
    ).rejects.toMatchObject({ code: 'content_limit' });
  });
});

describe('web isolation and host policy', () => {
  it('isolates accounts, URLs, language and geography; ignores only the fragment', async () => {
    const fetchMock = vi.fn(async () => pageResponse('Private to this request scope'));
    const { read } = setup(fetchMock);
    const args = { url: 'https://a.example/path?q=one#first', language: 'it', country: 'IT' };
    await read.execute(args, context('alice'));
    expect(
      (
        await read.execute(
          { ...args, url: 'https://a.example/path?q=one#second' },
          context('alice'),
        )
      ).page.source.cache,
    ).toBe('hit');
    await read.execute(args, context('bob'));
    await read.execute({ ...args, url: 'https://a.example/path?q=two' }, context('alice'));
    await read.execute({ ...args, language: 'en' }, context('alice'));
    await read.execute({ ...args, country: 'GB' }, context('alice'));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('expires local cache and forces both layers to refresh explicitly', async () => {
    vi.useFakeTimers();
    try {
      const bodies: Array<{ maxAge: number }> = [];
      const fetchMock = vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return pageResponse();
      });
      const { read } = setup(fetchMock, { cacheTtlMs: 100 });
      const first = await read.execute({ url: 'https://a.example' }, context());
      await vi.advanceTimersByTimeAsync(50);
      const cached = await read.execute({ url: 'https://a.example' }, context());
      expect(cached.page.source.retrievedAt).toBe(first.page.source.retrievedAt);
      await vi.advanceTimersByTimeAsync(51);
      await read.execute({ url: 'https://a.example' }, context());
      await read.execute({ url: 'https://a.example', refresh: true }, context());
      expect(bodies.map((body) => body.maxAge)).toEqual([300000, 300000, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'http://localhost',
    'http://service.internal',
    'http://127.0.0.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://169.254.169.254',
    'http://10.2.3.4',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'https://user:password@a.example',
    'file:///etc/passwd',
    'ftp://a.example/file',
  ])('blocks explicit unsafe target %s before network', async (url) => {
    const fetchMock = vi.fn();
    const { read } = setup(fetchMock);
    await expect(read.execute({ url }, context())).rejects.toMatchObject({
      code: 'blocked_domain',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe final redirect and never caches the rejected content', async () => {
    const fetchMock = vi.fn(async () =>
      pageResponse('Must not be exposed', {
        sourceURL: 'https://allowed.example',
        url: 'http://127.0.0.1',
      }),
    );
    const { read } = setup(fetchMock, { allowedDomains: ['allowed.example'] });
    for (let n = 0; n < 2; n++)
      await expect(
        read.execute({ url: 'https://allowed.example' }, context()),
      ).rejects.toMatchObject({ code: 'blocked_domain' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves taint/egress metadata for every web tool, including cache hits and batches', () => {
    const { read, search, batch } = setup(vi.fn());
    for (const tool of [read, search, batch]) {
      expect(tool.risk).toEqual({
        readsPrivate: false,
        ingestsUntrusted: true,
        externalEffect: false,
        write: false,
        egress: true,
      });
      expect(tool.untrustedSource).toBeTypeOf('function');
    }
    expect(batch.retry?.attempts).toBe(1);
  });

  it('keeps metadata warnings and rejects HTTP error pages and provider success=false', async () => {
    const client = createFirecrawlClient({
      apiKey: 'test',
      fetch: vi.fn(async () =>
        pageResponse('Not found', { statusCode: 404 }),
      ) as unknown as typeof fetch,
    });
    await expect(client.scrape('https://a.example', 3000)).rejects.toMatchObject({
      code: 'source_http_error',
    });
    const failed = createFirecrawlClient({
      apiKey: 'test',
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, data: { markdown: 'Not a real page' } })),
      ) as unknown as typeof fetch,
    });
    await expect(failed.scrape('https://a.example', 3000)).rejects.toMatchObject({
      code: 'bad_response',
    });
    const { read } = setup(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { markdown: 'Partial', warning: 'Incomplete extraction' } }),
          ),
      ),
    );
    expect((await read.execute({ url: 'https://a.example' }, context())).page.source.warning).toBe(
      'Incomplete extraction',
    );
  });
});

describe('bounded parallel source reading', () => {
  it('reads five independent pages in two waves instead of five, with at most three requests and a total text budget', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const fetchMock = vi.fn(async (_url, init) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        active--;
        const url = JSON.parse(String(init.body)).url;
        return pageResponse(`${url} ${'Testo lungo. '.repeat(500)}`);
      });
      const { batch } = setup(fetchMock);
      const urls = Array.from({ length: 5 }, (_, i) => `https://site${i}.example`);
      const start = Date.now();
      const pending = batch.execute({ urls, maxChars: 5000 }, context());
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(active).toBe(2);
      await vi.advanceTimersByTimeAsync(100);
      const out = await pending;
      expect(peak).toBe(3);
      expect(Date.now() - start).toBe(200);
      expect(out.sources.map((source: { url: string }) => source.url)).toEqual(urls);
      expect(out.coverage).toMatchObject({
        successfulSources: 5,
        failedSources: 0,
        maxChars: 5000,
        timedOut: false,
      });
      expect(out.coverage.returnedChars).toBeLessThanOrEqual(5000);
      expect(batch.outputSchema.safeParse(out).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates identical URLs, keeps partial success and does not retry the whole batch', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const url = JSON.parse(String(init.body)).url;
      return url.includes('bad.example')
        ? new Response('sensitive provider details', { status: 503 })
        : pageResponse();
    });
    const { batch } = setup(fetchMock, { blockedDomains: ['blocked.example'] });
    const out = await batch.execute(
      {
        urls: [
          'https://ok.example#one',
          'https://ok.example#two',
          'https://bad.example',
          'https://blocked.example',
        ],
      },
      context(),
    );
    expect(out.sources).toHaveLength(3);
    expect(out.coverage).toMatchObject({
      requestedSources: 3,
      successfulSources: 1,
      failedSources: 2,
    });
    expect(out.sources[1]?.error).toMatchObject({ code: 'upstream', retryable: true });
    expect(out.sources[2]?.error?.code).toBe('blocked_domain');
    expect(JSON.stringify(out)).not.toContain('sensitive provider details');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces the overall deadline and settles a transport that ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn(async (_url, init) => {
        signals.push(init.signal);
        return new Promise<Response>(() => {});
      });
      const { batch } = setup(fetchMock, { batchTimeoutMs: 50, sourceTimeoutMs: 100 });
      const pending = batch.execute(
        {
          urls: [
            'https://a.example',
            'https://b.example',
            'https://c.example',
            'https://d.example',
            'https://e.example',
          ],
        },
        context(),
      );
      await vi.advanceTimersByTimeAsync(50);
      const out = await pending;
      expect(out.coverage).toMatchObject({
        successfulSources: 0,
        failedSources: 5,
        timedOut: true,
      });
      expect(out.sources.slice(3).map((source) => source.error?.code)).toEqual([
        'budget_exceeded',
        'budget_exceeded',
      ]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels active reads and never launches queued ones or caches late output', async () => {
    const controller = new AbortController();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { batch, read } = setup(fetchMock, { batchConcurrency: 1 });
    const pending = batch.execute(
      { urls: ['https://a.example', 'https://b.example'] },
      context('alice', controller.signal),
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch?.(pageResponse('Late untrusted content'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchMock.mockImplementation(async () => pageResponse('New valid content'));
    const out = await read.execute({ url: 'https://a.example' }, context());
    expect(out.page.content).toBe('New valid content');
    expect(out.page.source.cache).toBe('miss');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
