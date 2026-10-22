import type { ModelGateway } from '@ernie/model-gateway';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = mocks.generate;
  },
}));

import { createSummarizer } from './summarize.js';

const scope = { userId: 'u', sessionId: null, requestId: 'r' };
const doc = { id: 'd', title: 'Documento', pageTexts: ['Contenuto'] };
function setup(checkBudget = vi.fn(async (_id: string) => {})) {
  const resolve = vi.fn(() => ({ model: 'test', provider: 'test', profile: { modelId: 'test' } }));
  const recorder = { record: vi.fn(async () => {}) };
  const summarizer = createSummarizer({
    gateway: { resolve } as unknown as ModelGateway,
    recorder,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    checkBudget,
    singleCallChars: 20,
    chunkChars: 10,
  });
  return { summarizer, checkBudget, resolve, recorder };
}
beforeEach(() => mocks.generate.mockReset());
describe('budget e annullamento dei documenti', () => {
  it('non contatta il provider se il budget è esaurito o la richiesta è già annullata', async () => {
    const s = setup(
      vi.fn(async () => {
        throw new Error('budget raggiunto');
      }),
    );
    await expect(s.summarizer.summarize(doc, scope)).rejects.toThrow('budget raggiunto');
    expect(s.resolve).not.toHaveBeenCalled();
    const canceled = setup();
    await expect(
      canceled.summarizer.summarize(doc, { ...scope, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(canceled.checkBudget).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('ricontrolla il budget dopo un output troncato prima di riprovare', async () => {
    const check = vi.fn(async () => {});
    check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('budget raggiunto'));
    const s = setup(check);
    mocks.generate.mockResolvedValueOnce({ object: null, finishReason: 'length', usage: {} });
    await expect(s.summarizer.summarize(doc, scope)).rejects.toThrow('budget raggiunto');
    expect(check).toHaveBeenCalledTimes(2);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(s.recorder.record).toHaveBeenCalledTimes(1);
  });
  it('interrompe una pipeline di più pezzi quando il primo ha esaurito il budget', async () => {
    const check = vi.fn(async () => {});
    check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('budget raggiunto'));
    const s = setup(check);
    mocks.generate.mockResolvedValueOnce({
      object: { summary: 'Appunto', keyPoints: [] },
      usage: {},
    });
    await expect(
      s.summarizer.summarize({ ...doc, pageTexts: ['a'.repeat(15), 'b'.repeat(15)] }, scope),
    ).rejects.toThrow('budget raggiunto');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
