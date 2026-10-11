import { describe, expect, it, vi } from 'vitest';
import { createFirecrawlClient, createWebTools, sanitizeWebContent } from './builtins/web.js';
import { ToolError } from './types.js';

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
