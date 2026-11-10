import { describe, expect, it, vi } from 'vitest';
import {
  createChatModelCatalog,
  eligibleForSSH,
  parseAnthropicCatalog,
  parseRouterCatalog,
  selectionProfile,
} from './catalog.js';
import { buildProfiles } from './models.js';

const router = {
  id: 'openai/gpt-6.1-sol',
  name: 'Sol',
  context_length: 1000000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'reasoning'],
  pricing: { prompt: '0.000002', completion: '0.00001' },
  top_provider: { max_completion_tokens: 128000 },
  reasoning: { mandatory: true, supported_efforts: ['low', 'high', 'max'] },
};
const anthropic = {
  id: 'claude-fable-5-2',
  display_name: 'Fable',
  max_input_tokens: 1000000,
  max_tokens: 128000,
  capabilities: {
    structured_outputs: { supported: true },
    image_input: { supported: true },
    thinking: { types: { adaptive: { supported: true }, disabled: { supported: false } } },
    effort: { low: { supported: true }, max: { supported: true } },
  },
};
const base = buildProfiles({ light: 'l', standard: 's', heavy: 'h' }).standard;

describe('catalog and explicit selection', () => {
  it('keeps only usable chat models and actual supported effort levels', () => {
    const models = parseRouterCatalog([
      router,
      { ...router, id: 'openrouter/auto' },
      { ...router, supported_parameters: [] },
      { ...router, pricing: { prompt: 'oops', completion: '0' } },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.efforts).toEqual(['default', 'low', 'high', 'max']);
    expect(models[0]?.price.inputPerM).toBe(2);
    expect(parseRouterCatalog([{ ...router, reasoning: undefined }])[0]?.efforts).toEqual([
      'default',
    ]);
    expect(
      parseRouterCatalog([
        { ...router, reasoning: { mandatory: false, supported_efforts: ['none', 'low'] } },
      ])[0]?.efforts,
    ).toEqual(['default', 'off', 'low']);
  });
  it('direct catalog excludes unknown pricing and unsupported adapters; mandatory reasoning has no off', () => {
    expect(
      parseAnthropicCatalog([
        anthropic,
        { ...anthropic, id: 'unknown' },
        { ...anthropic, capabilities: {} },
      ]),
    ).toHaveLength(1);
    const model = parseAnthropicCatalog([anthropic])[0]!;
    expect(model.efforts).toEqual(['default', 'low', 'max']);
    expect(model.price).toEqual({
      inputPerM: 8,
      outputPerM: 40,
      cacheReadPerM: 0.2,
      cacheWritePerM: 10,
    });
    expect(model.sshEligible).toBe(true);
    expect(eligibleForSSH('openai/claude-opus-5.5')).toBe(false);
  });
  it('rejects mismatched provider/model/effort and bounds total output without changing tool step limits', () => {
    const catalog = { models: parseRouterCatalog([router]), updatedAt: 'now', unavailable: [] };
    const selection = {
      provider: 'openrouter' as const,
      modelId: router.id,
      effort: 'max' as const,
    };
    const profile = selectionProfile(selection, catalog, base);
    expect(profile).toMatchObject({
      maxOutputTokens: 32768,
      maxSteps: base.maxSteps,
      modelId: router.id,
      reasoning: 'max',
    });
    expect(() => selectionProfile({ ...selection, provider: 'anthropic' }, catalog, base)).toThrow(
      'non è disponibile',
    );
    expect(() => selectionProfile({ ...selection, effort: 'off' }, catalog, base)).toThrow(
      'non è supportato',
    );
  });
  it('shares parallel loads, uses TTL, and does not retain expired models after provider failure', async () => {
    let now = 1000000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [router] })));
    const catalog = createChatModelCatalog({ openrouterApiKey: 'test' }, fetcher, () => now);
    const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await catalog.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 900001;
    fetcher.mockResolvedValueOnce(new Response('', { status: 401 }));
    expect(await catalog.get()).toMatchObject({ models: [], unavailable: ['openrouter'] });
  });
  it('does not contact unconfigured providers', async () => {
    const fetcher = vi.fn();
    expect((await createChatModelCatalog({}, fetcher).get()).models).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
