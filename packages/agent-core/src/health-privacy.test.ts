import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { ModelGateway } from '@ernie/model-gateway';
import { describe, expect, it, vi } from 'vitest';
import { createHealthAnswerer } from './health-answer.js';
import { createHealthExtractor } from './health-extract.js';

describe('health provider error privacy', () => {
  it.each(['answer', 'extract'] as const)(
    'does not log sensitive request bodies on %s failures',
    async (kind) => {
      const marker = 'SYNTHETIC_PRIVATE_HEALTH_MARKER';
      const logs: string[] = [];
      const spies = (['error', 'warn', 'info', 'log', 'debug'] as const).map((name) =>
        vi.spyOn(console, name).mockImplementation((...args) => {
          logs.push(inspect(args, { depth: 10 }));
        }),
      );
      try {
        const fail = async () => {
          throw Object.assign(new Error('SYNTHETIC_HEALTH_PROVIDER_ERROR'), {
            requestBodyValues: { messages: [{ content: marker }] },
          });
        };
        const model = {
          specificationVersion: 'v4',
          provider: 'synthetic',
          modelId: 'synthetic',
          supportedUrls: {},
          doGenerate: fail,
          doStream: fail,
        };
        const gateway = {
          resolve: () => ({ model, provider: 'synthetic', profile: { modelId: 'synthetic' } }),
        } as unknown as ModelGateway;
        const recorder = { record: vi.fn(async () => {}) };
        if (kind === 'answer')
          await createHealthAnswerer({ gateway, recorder })({
            userId: randomUUID(),
            question: marker,
            context: marker,
            signal: new AbortController().signal,
          }).catch(() => {});
        else await createHealthExtractor({ gateway, recorder })(marker, { userId: randomUUID() });
        expect(
          logs.some(
            (line) => line.includes(marker) || line.includes('SYNTHETIC_HEALTH_PROVIDER_ERROR'),
          ),
        ).toBe(false);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  );
});
