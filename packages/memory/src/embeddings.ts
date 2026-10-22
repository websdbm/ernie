import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { modelRetryDelayMs, transientModelError } from '@ernie/model-gateway';
import { embedMany, wrapEmbeddingModel } from 'ai';

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<{ vectors: number[][]; tokens: number }>;
}

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

const EMBEDDING_DEADLINE_MS = 8_000;
const PERMANENT_COOLDOWN_MS = 120_000;
const TRANSIENT_COOLDOWN_MS = 30_000;

function permanentEmbeddingFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { statusCode?: number; message?: string; responseBody?: string };
  return (
    [401, 402, 403].includes(value.statusCode ?? 0) ||
    /insufficient_quota|insufficient[ _]credits|no credits remaining|credit balance|exceeded your current quota/i.test(
      `${value.message ?? ''} ${value.responseBody ?? ''}`,
    )
  );
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** OpenAI via AI SDK: text-embedding-3-small, 1536 dimensioni (listino: 0,02 $/M token). */
export function createOpenAIEmbedder(
  apiKey: string,
  model = DEFAULT_EMBEDDING_MODEL,
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
): Embedder {
  const openai = createOpenAI({ apiKey });
  const embeddingModel = openai.embedding(model);
  let unavailableUntil = 0;
  let probing = false;
  let epoch = 0;
  const pause = (ms: number) => {
    unavailableUntil = Math.max(unavailableUntil, Date.now() + ms);
    epoch++;
  };
  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      if (probing || unavailableUntil > Date.now())
        throw new Error('embedding temporarily unavailable');
      const probe = unavailableUntil > 0;
      const startedEpoch = epoch;
      if (probe) probing = true;
      const controller = new AbortController();
      const deadlineAt = Date.now() + EMBEDDING_DEADLINE_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new DOMException('embedding deadline exceeded', 'TimeoutError');
          controller.abort(error);
          reject(error);
        }, EMBEDDING_DEADLINE_MS);
      });
      try {
        const { embeddings, usage } = await Promise.race([
          embedMany({
            // Retry individual chunks only: never replay chunks that already succeeded.
            model: wrapEmbeddingModel({
              model: embeddingModel,
              middleware: {
                wrapEmbed: async ({ doEmbed }) => {
                  for (let attempt = 0; ; attempt++) {
                    controller.signal.throwIfAborted();
                    // Another concurrent request may already have discovered an outage.
                    if (epoch !== startedEpoch && unavailableUntil > Date.now())
                      throw new Error('embedding temporarily unavailable');
                    try {
                      return await doEmbed();
                    } catch (error) {
                      if (controller.signal.aborted) throw controller.signal.reason;
                      if (permanentEmbeddingFailure(error)) {
                        pause(PERMANENT_COOLDOWN_MS);
                        throw error;
                      }
                      if (!transientModelError(error)) throw error;
                      const waitMs = modelRetryDelayMs(error, attempt);
                      if (attempt >= 1 || waitMs === null || waitMs >= deadlineAt - Date.now()) {
                        pause(Math.max(TRANSIENT_COOLDOWN_MS, waitMs ?? PERMANENT_COOLDOWN_MS));
                        throw error;
                      }
                      await waitForRetry(waitMs, controller.signal);
                    }
                  }
                },
              },
            }),
            values: [...texts],
            maxParallelCalls: probe ? 1 : 2,
            maxRetries: 0,
            abortSignal: controller.signal,
          }),
          deadline,
        ]);
        // A stale successful call must not close a circuit opened by a concurrent failure.
        if (probe && epoch === startedEpoch) unavailableUntil = 0;
        return { vectors: embeddings, tokens: usage?.tokens ?? 0 };
      } catch (error) {
        if ((error as { name?: string })?.name === 'TimeoutError') pause(TRANSIENT_COOLDOWN_MS);
        throw error; // Existing repository/index fallback remains responsible for full-text search.
      } finally {
        clearTimeout(timer);
        controller.abort(); // Stop any sibling chunk still in flight after a rejection.
        if (probe) probing = false;
      }
    },
  };
}

/**
 * Embedder deterministico senza rete per i test: bag-of-words con hashing in `dimensions` posizioni,
 * normalizzato. Testi che condividono parole hanno similarità coseno alta.
 */
export function createFakeEmbedder(dimensions = DEFAULT_EMBEDDING_DIMENSIONS): Embedder {
  return {
    model: `fake-bow-${dimensions}`,
    dimensions,
    async embed(texts) {
      const vectors = texts.map((text) => {
        const v = new Array<number>(dimensions).fill(0);
        for (const tok of text
          .toLowerCase()
          .normalize('NFKC')
          .split(/[^\p{L}\p{N}]+/u)) {
          if (tok.length < 2) continue;
          const h = createHash('sha1').update(tok).digest();
          const idx = h.readUInt32BE(0) % dimensions;
          v[idx] = (v[idx] ?? 0) + 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, tokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0) };
    },
  };
}

export function toPgVector(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(7) : '0')).join(',')}]`;
}
