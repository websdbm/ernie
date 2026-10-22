import type { LlmCallRecorder, ModelGateway } from '@ernie/model-gateway';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), options: vi.fn() }));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    generate = mocks.generate;
  },
}));

import { createBrainReviewer, selectReviewNotes } from './brain-review.js';

const note = (i: number) => ({
  path: `Note/${i}.md`,
  title: `Nota ${i}`,
  type: i < 10 ? 'persona' : 'nota',
  body: 'Dato originale. '.repeat(200),
  place: null,
  created: '2026-10-17',
});
beforeEach(() => {
  mocks.generate.mockReset();
  mocks.options.mockReset();
});
describe('revisore semantico isolato', () => {
  it('ruota le finestre dei vault grandi e non perde le note meno recenti', () => {
    const notes = Array.from({ length: 200 }, (_, i) => note(i));
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const batch = selectReviewNotes(notes, i);
      expect(batch).toHaveLength(60);
      for (const n of batch) seen.add(n.path);
    }
    expect(seen.size).toBe(200);
  });
  it('limita il contesto, non dispone di strumenti e contabilizza il consumo', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const gateway = {
      resolve: vi.fn().mockReturnValue({
        model: 'openai/test',
        provider: 'openai',
        profile: { modelId: 'test' },
      }),
    } as unknown as ModelGateway;
    mocks.generate.mockResolvedValue({
      object: { connections: [], questions: [] },
      usage: { inputTokens: 100, outputTokens: 20 },
      response: { id: 'gen-test' },
      finishReason: 'stop',
    });
    const review = createBrainReviewer({
      gateway,
      recorder: { record } as unknown as LlmCallRecorder,
    });
    expect(await review([note(0)], 'u')).toEqual({ connections: [], questions: [] });
    expect(mocks.generate).not.toHaveBeenCalled();
    await review(
      Array.from({ length: 100 }, (_, i) => note(i)),
      'u',
    );
    const [prompt, options] = mocks.generate.mock.calls[0] ?? [];
    expect((prompt as string).length).toBeLessThan(40000);
    expect(options.maxSteps).toBe(1);
    expect(mocks.options.mock.calls[0]?.[0].tools).toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u',
        purpose: 'memory',
        modelClass: 'light',
        generationId: 'gen-test',
      }),
    );
    mocks.generate.mockResolvedValue({ object: { connections: 'invalid' }, usage: {} });
    expect(await review([note(0), note(1)], 'u')).toBeNull();
  });
});
