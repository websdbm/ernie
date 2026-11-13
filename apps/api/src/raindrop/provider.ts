import { z } from 'zod';

const API = 'https://api.raindrop.io/rest/v1';
const MCP = 'https://api.raindrop.io/rest/v2/ai/mcp';
const MAX_BYTES = 1_500_000;
export class RaindropError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export const Token = z
  .string()
  .trim()
  .min(16)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CollectionId = z.union([Id, z.literal(-1)]);
export const Search = z
  .object({
    query: z.string().trim().max(300).default(''),
    collectionId: z.union([CollectionId, z.literal(0)]).default(0),
    page: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(25).default(15),
  })
  .strict();
export const Save = z
  .object({
    url: z
      .url()
      .max(4000)
      .refine((s) => {
        const u = new URL(s);
        return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
      }, 'Usa un link web senza credenziali.'),
    title: z.string().trim().max(300).optional(),
    collectionId: CollectionId.default(-1),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    note: z.string().max(4000).optional(),
  })
  .strict();
export interface RaindropAccount {
  id: number;
  name: string;
  pro: boolean;
}
export interface Bookmark {
  id: number;
  title: string;
  url: string;
  collectionId: number;
  tags: string[];
  excerpt: string;
  note: string;
  highlights: string[];
  updatedAt: string | null;
}
export interface Collection {
  id: number;
  title: string;
  parentId: number | null;
  count: number;
}
export const READ_TOOLS = ['find_bookmarks', 'fetch_bookmark_content', 'find_highlights'] as const;
export const McpRead = z
  .object({
    tool: z.enum(READ_TOOLS),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const string = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const number = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
function bookmark(v: unknown): Bookmark {
  const b = object(v);
  const id = number(b._id);
  if (id <= 0) throw unavailable();
  const link = string(b.link, 4000);
  let url = '';
  try {
    const u = new URL(link);
    if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) url = u.href;
  } catch {
    /* no unsafe links */
  }
  return {
    id,
    title: string(b.title, 300),
    url,
    collectionId: number(object(b.collection).$id),
    tags: Array.isArray(b.tags)
      ? b.tags
          .filter((t): t is string => typeof t === 'string')
          .slice(0, 20)
          .map((t) => t.slice(0, 60))
      : [],
    excerpt: string(b.excerpt, 3000),
    note: string(b.note, 5000),
    highlights: Array.isArray(b.highlights)
      ? b.highlights
          .slice(0, 30)
          .map((h) => string(object(h).text, 3000))
          .filter(Boolean)
      : [],
    updatedAt: typeof b.lastUpdate === 'string' ? b.lastUpdate.slice(0, 40) : null,
  };
}
const unavailable = () =>
  new RaindropError('provider_unavailable', 'Raindrop non è disponibile. Riprova fra poco.', 502);
export interface RaindropProvider {
  account(token: string, signal?: AbortSignal): Promise<RaindropAccount>;
  search(
    token: string,
    input: z.infer<typeof Search>,
    signal?: AbortSignal,
  ): Promise<{ items: Bookmark[]; nextPage: number | null }>;
  get(token: string, id: number, signal?: AbortSignal): Promise<Bookmark>;
  collections(token: string, signal?: AbortSignal): Promise<Collection[]>;
  save(
    token: string,
    input: z.infer<typeof Save>,
    signal?: AbortSignal,
  ): Promise<{ item: Bookmark; alreadyExists: boolean }>;
  readTools(token: string, signal?: AbortSignal): Promise<unknown[]>;
  read(token: string, input: z.infer<typeof McpRead>, signal?: AbortSignal): Promise<unknown>;
}

export function createRaindropProvider(http: typeof fetch = fetch): RaindropProvider {
  const request = async (
    url: string,
    token: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<{ data: unknown; session: string | null }> => {
    try {
      const response = await http(url, {
        ...init,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...init.headers,
          Authorization: `Bearer ${Token.parse(token)}`,
        },
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
      if ([401, 403].includes(response.status))
        throw new RaindropError(
          'authorization_required',
          'Raindrop ha rifiutato l’accesso. Verifica il piano o ricollega l’account.',
          401,
        );
      if (response.status === 429)
        throw new RaindropError(
          'rate_limited',
          'Raindrop ha raggiunto il limite di richieste. Attendi prima di riprovare.',
          429,
        );
      if (response.status === 404)
        throw new RaindropError(
          'not_found',
          'Elemento Raindrop non trovato o non accessibile.',
          404,
        );
      if (!response.ok) throw unavailable();
      if (response.status === 202 || response.status === 204)
        return { data: {}, session: response.headers.get('mcp-session-id') };
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const sse = response.headers.get('content-type')?.includes('text/event-stream');
      const expectedId =
        typeof init.body === 'string' ? object(JSON.parse(init.body)).id : undefined;
      let data: unknown;
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > MAX_BYTES) throw unavailable();
          chunks.push(r.value);
          if (sse) {
            const frames = Buffer.concat(chunks)
              .toString('utf8')
              .split(/\r?\n\r?\n/)
              .slice(0, -1);
            for (const frame of frames) {
              const raw = frame
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trimStart())
                .join('\n');
              if (!raw) continue;
              const candidate = object(JSON.parse(raw));
              if (candidate.id === expectedId && ('result' in candidate || 'error' in candidate))
                data = candidate;
            }
            if (data) break;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!sse) data = JSON.parse(text);
      return { data, session: response.headers.get('mcp-session-id') };
    } catch (e) {
      if (e instanceof RaindropError) throw e;
      if (signal?.aborted)
        throw new RaindropError('cancelled', 'Richiesta Raindrop interrotta.', 409);
      throw unavailable(); // Never propagate provider errors, bodies, URLs or credentials.
    }
  };
  const rest = async (token: string, path: string, init?: RequestInit, signal?: AbortSignal) => {
    const { data } = await request(`${API}${path}`, token, init, signal);
    const out = object(data);
    if (out.result !== true) throw unavailable();
    return out;
  };
  const mcp = async <T>(
    token: string,
    run: (rpc: (method: string, params: Obj) => Promise<Obj>) => Promise<T>,
    signal?: AbortSignal,
  ) => {
    let session: string | null = null;
    let id = 0;
    const rpc = async (method: string, params: Obj, notification = false): Promise<Obj> => {
      const r = await request(
        MCP,
        token,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2025-03-26',
            ...(session ? { 'Mcp-Session-Id': session } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            ...(notification ? {} : { id: ++id }),
            method,
            params,
          }),
        },
        signal,
      );
      session = r.session ?? session;
      if (notification) return {};
      const out = object(r.data);
      if (out.id !== id || out.error || !out.result)
        throw new RaindropError(
          'mcp_unavailable',
          'Le funzioni avanzate Raindrop non sono disponibili per questo collegamento o piano.',
          502,
        );
      return object(out.result);
    };
    try {
      await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Ernie', version: '1.0' },
      });
      await rpc('notifications/initialized', {}, true);
      return await run(rpc);
    } finally {
      if (session)
        await http(MCP, {
          method: 'DELETE',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${token}`,
            'Mcp-Session-Id': session,
            'MCP-Protocol-Version': '2025-03-26',
          },
          signal: AbortSignal.timeout(2000),
        }).catch(() => {});
    }
  };
  const readTools = async (rpc: (method: string, params: Obj) => Promise<Obj>) => {
    const r = await rpc('tools/list', {});
    return (Array.isArray(r.tools) ? r.tools : [])
      .map(object)
      .filter((t) => READ_TOOLS.includes(t.name as (typeof READ_TOOLS)[number]))
      .map((t) => ({
        name: t.name,
        description: string(t.description, 1200),
        inputSchema: t.inputSchema,
      }));
  };
  return {
    async account(token, signal) {
      const u = object((await rest(token, '/user', undefined, signal)).user);
      if (number(u._id) <= 0) throw unavailable();
      return {
        id: number(u._id),
        name: string(u.fullName, 160) || 'Account Raindrop',
        pro: u.pro === true,
      };
    },
    async search(token, input, signal) {
      const p = Search.parse(input);
      const q = new URLSearchParams({
        search: p.query,
        page: String(p.page),
        perpage: String(p.limit),
        nested: 'true',
        sort: p.query ? 'score' : '-created',
      });
      const r = await rest(token, `/raindrops/${p.collectionId}?${q}`, undefined, signal);
      if (!Array.isArray(r.items)) throw unavailable();
      const items = r.items.slice(0, p.limit).map(bookmark);
      return { items, nextPage: items.length === p.limit ? p.page + 1 : null };
    },
    async get(token, id, signal) {
      return bookmark((await rest(token, `/raindrop/${Id.parse(id)}`, undefined, signal)).item);
    },
    async collections(token, signal) {
      const responses = await Promise.all(
        ['/collections', '/collections/childrens'].map((path) =>
          rest(token, path, undefined, signal),
        ),
      );
      const items = responses.flatMap((r) => (Array.isArray(r.items) ? r.items : []));
      return [
        ...new Map(
          items
            .map((v) => {
              const c = object(v);
              const id = number(c._id);
              return [
                id,
                {
                  id,
                  title: string(c.title, 300),
                  parentId: number(object(c.parent).$id) || null,
                  count: number(c.count),
                },
              ] as const;
            })
            .filter(([id]) => id > 0),
        ).values(),
      ].slice(0, 2000);
    },
    async save(token, input, signal) {
      const p = Save.parse(input);
      // No automatic retries: an uncertain external write must be checked before another attempt.
      const r = await rest(
        token,
        '/raindrop',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            link: p.url,
            title: p.title,
            collection: { $id: p.collectionId },
            tags: p.tags,
            note: p.note,
            pleaseParse: {},
          }),
        },
        signal,
      );
      return { item: bookmark(r.item), alreadyExists: r.duplicate === true };
    },
    readTools: (token, signal) => mcp(token, readTools, signal),
    read: (token, input, signal) =>
      mcp(
        token,
        async (rpc) => {
          const p = McpRead.parse(input);
          const tools = await readTools(rpc);
          const tool = tools.find((t) => t.name === p.tool);
          if (!tool)
            throw new RaindropError(
              'unsupported_tool',
              'Questa funzione di lettura non è disponibile.',
              400,
            );
          // Validate against the live official schema; never expose arbitrary MCP writes.
          try {
            z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema).parse(p.arguments);
          } catch {
            throw new RaindropError(
              'invalid_arguments',
              'Argomenti non validi: rileggi lo schema con raindrop_read_tools.',
              400,
            );
          }
          const r = await rpc('tools/call', { name: p.tool, arguments: p.arguments });
          if (r.isError === true)
            throw new RaindropError(
              'content_unavailable',
              'Raindrop non ha restituito il contenuto. Verifica disponibilità e piano; non dedurre il testo dal titolo.',
              502,
            );
          return r;
        },
        signal,
      ),
  };
}
