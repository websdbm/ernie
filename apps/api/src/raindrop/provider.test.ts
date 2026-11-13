import { describe, expect, it, vi } from 'vitest';
import { createRaindropProvider, McpRead, Save, Search } from './provider.js';

const token = 'synthetic-raindrop-token-123';
const b = {
  _id: 25,
  title: 'Agenti',
  link: 'https://example.test/article',
  collection: { $id: 5 },
  tags: ['ai'],
  excerpt: 'Solo estratto',
  note: 'Nota privata',
  highlights: [{ text: 'Passaggio scelto' }],
  lastUpdate: '2026-11-13T10:00:00Z',
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
describe('Raindrop official provider', () => {
  it('uses fixed host, no redirects, bounded paging and normalized safe bookmark fields', async () => {
    const http = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/api\.raindrop\.io\/rest\/v1\//);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
      return json({ result: true, items: [b] });
    });
    const result = await createRaindropProvider(http).search(
      token,
      Search.parse({ query: '#ai', limit: 1, collectionId: 5 }),
    );
    expect(result.nextPage).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 25,
      excerpt: 'Solo estratto',
      highlights: ['Passaggio scelto'],
      url: b.link,
    });
    const url = new URL(String(http.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search')).toBe('#ai');
    expect(url.searchParams.get('nested')).toBe('true');
    expect(result).not.toHaveProperty('token');
  });
  it('validates /user without importing data; reads root and child collections', async () => {
    const http = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/user')
        ? json({
            result: true,
            user: { _id: 3, fullName: 'Synthetic', pro: true, email: 'hidden@example.test' },
          })
        : json({
            result: true,
            items: [{ _id: 5, title: 'Lavoro', count: 8, parent: { $id: 2 } }],
          }),
    );
    const p = createRaindropProvider(http);
    expect(await p.account(token)).toEqual({ id: 3, name: 'Synthetic', pro: true });
    expect(await p.collections(token)).toEqual([{ id: 5, title: 'Lavoro', parentId: 2, count: 8 }]);
    expect(http.mock.calls).toHaveLength(3);
  });
  it.each([401, 403, 429, 500])(
    'does not disclose provider bodies or retry failures (%s)',
    async (status) => {
      const http = vi.fn<typeof fetch>(async () =>
        json({ error: token, details: 'private article' }, status),
      );
      await expect(createRaindropProvider(http).account(token)).rejects.not.toThrow(token);
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects unsafe saved links, header injection and unbounded inputs', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:secret@example.test',
    ])
      expect(Save.safeParse({ url }).success).toBe(false);
    expect(Search.safeParse({ limit: 1000 }).success).toBe(false);
    expect(McpRead.safeParse({ tool: 'delete_bookmarks', arguments: {} }).success).toBe(false);
  });
  it('performs one save only; never retries an uncertain write', async () => {
    const http = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        collection: { $id: -1 },
        link: b.link,
      });
      return json({ result: true, item: b, duplicate: true });
    });
    expect(
      (await createRaindropProvider(http).save(token, Save.parse({ url: b.link }))).alreadyExists,
    ).toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('reads live MCP schemas, filters writes and handles SSE that stays open after our response', async () => {
    const methods: string[] = [];
    const http = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const req = JSON.parse(String(init?.body));
      methods.push(req.method);
      if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result =
        req.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'synthetic', version: '1' },
            }
          : req.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'fetch_bookmark_content',
                    inputSchema: {
                      type: 'object',
                      properties: { id: { type: 'number' } },
                      required: ['id'],
                      additionalProperties: false,
                    },
                  },
                  { name: 'delete_bookmarks', inputSchema: { type: 'object' } },
                ],
              }
            : { content: [{ type: 'text', text: 'Full synthetic article' }] };
      const data = new TextEncoder().encode(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n\n`,
      );
      const body = new ReadableStream({
        start(c) {
          c.enqueue(data); /* intentionally not closed */
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'synthetic-session' },
      });
    });
    const p = createRaindropProvider(http);
    expect(await p.readTools(token)).toEqual([
      expect.objectContaining({ name: 'fetch_bookmark_content' }),
    ]);
    expect(await p.read(token, { tool: 'fetch_bookmark_content', arguments: { id: 25 } })).toEqual({
      content: [{ type: 'text', text: 'Full synthetic article' }],
    });
    await expect(
      p.read(token, { tool: 'fetch_bookmark_content', arguments: { command: 'delete' } }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(methods.filter((m) => m === 'tools/call')).toHaveLength(1);
    expect(http.mock.calls.filter(([, i]) => i?.method === 'DELETE')).toHaveLength(3);
  });
  it('fails closed for oversized payloads and never returns raw fields with credentials', async () => {
    const http = vi.fn<typeof fetch>(async () =>
      json({ result: true, item: { ...b, link: 'javascript:bad', token } }),
    );
    expect(await createRaindropProvider(http).get(token, 25)).toMatchObject({ url: '' });
    const large = createRaindropProvider(async () => new Response('x'.repeat(1_500_001)));
    await expect(large.account(token)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
