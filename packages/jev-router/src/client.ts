import { JEV_DECISIONS_URL, JEV_DEFAULT_MODEL, type JevRequest, JevResponse } from './schema.js';

export interface JevClient {
  decide(
    request: Omit<JevRequest, 'model'> & { model?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<JevResponse>;
}

export class JevApiError extends Error {
  override readonly name = 'JevApiError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: string | undefined,
  ) {
    super(message);
  }
}

export interface HttpJevClientOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  readonly fetch?: typeof fetch;
  readonly referer?: string;
  readonly title?: string;
}

/** Client HTTP della Decisions API. Nessun retry: il chiamante applica timeout e fallback. */
export function createHttpJevClient(opts: HttpJevClientOptions): JevClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = opts.url ?? JEV_DECISIONS_URL;
  const model = opts.model ?? JEV_DEFAULT_MODEL;
  return {
    async decide(request, o = {}) {
      const body = JSON.stringify({
        model: request.model ?? model,
        state: request.state,
        questions: request.questions,
      });
      const init: RequestInit = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': opts.referer ?? 'https://github.com/websdbm/ernie',
          'X-Title': opts.title ?? 'Ernie',
        },
        body,
      };
      if (o.signal) init.signal = o.signal;
      const res = await doFetch(url, init);
      const text = await res.text();
      if (!res.ok)
        throw new JevApiError(`Decisions API ${res.status}`, res.status, text.slice(0, 500));
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new JevApiError('risposta non JSON', res.status, text.slice(0, 200));
      }
      const parsed = JevResponse.safeParse(json);
      if (!parsed.success)
        throw new JevApiError(
          `risposta non conforme: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
          res.status,
          text.slice(0, 500),
        );
      return parsed.data;
    },
  };
}

export type MockAnswerFn = (
  request: Omit<JevRequest, 'model'> & { model?: string },
) => JevResponse['answers'];

/**
 * Mock tipizzato per test e ambienti senza chiave: stessa forma di risposta.
 * Di default risponde con un profilo "conversazione standard".
 */
export function createMockJevClient(
  answer?: MockAnswerFn,
  opts: { latencyMs?: number; failWith?: Error } = {},
): JevClient & { calls: number } {
  const client = {
    calls: 0,
    async decide(
      request: Omit<JevRequest, 'model'> & { model?: string },
      o: { signal?: AbortSignal } = {},
    ) {
      client.calls++;
      if (opts.latencyMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.latencyMs);
          o.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      }
      if (opts.failWith) throw opts.failWith;
      const answers: JevResponse['answers'] = answer
        ? answer(request)
        : Object.fromEntries(
            Object.entries(request.questions).map(([name, q]) => {
              if (q.type === 'noul') return [name, { type: 'noul', noul: 0.2 }];
              if (q.type === 'choice') {
                const keys = Object.keys(q.criteria);
                const pick = keys.includes('llm')
                  ? 'llm'
                  : keys.includes('standard')
                    ? 'standard'
                    : keys.includes('none')
                      ? 'none'
                      : (keys[0] as string);
                return [
                  name,
                  {
                    type: 'choice',
                    choice: pick,
                    probabilities: Object.fromEntries(
                      keys.map((k) => [k, k === pick ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]),
                    ),
                    confidence: 0.9,
                  },
                ];
              }
              return [name, { type: 'score', score: 0, probabilities: { '0': 1 }, confidence: 1 }];
            }),
          );
      return {
        id: `mock-${client.calls}`,
        model: 'mock/jev',
        provider: 'mock',
        answers,
        usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
      };
    },
  };
  return client;
}
