import { createHash } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<{ vectors: number[][]; tokens: number }>;
}

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** OpenAI via AI SDK: text-embedding-3-small, 1536 dimensioni (listino: 0,02 $/M token). */
export function createOpenAIEmbedder(
  apiKey: string,
  model = DEFAULT_EMBEDDING_MODEL,
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
): Embedder {
  const openai = createOpenAI({ apiKey });
  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      const { embeddings, usage } = await embedMany({
        model: openai.embedding(model),
        values: [...texts],
        maxParallelCalls: 2,
      });
      return { vectors: embeddings, tokens: usage?.tokens ?? 0 };
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
