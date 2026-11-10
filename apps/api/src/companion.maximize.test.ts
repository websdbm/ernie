import { buildProfiles, type ChatModel } from '@ernie/model-gateway';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from './auth.js';
import { createCompanionFactory } from './companion.js';
import type { SessionRecord } from './sessions/store.js';

const build = vi.hoisted(() =>
  vi.fn((input) => ({ profile: input.modelOverride?.profile ?? { modelId: 'auto' }, input })),
);
vi.mock('@ernie/agent-core', async (original) => ({
  ...(await original<object>()),
  createCompanionAgent: build,
}));

describe('per-conversation Maximize', () => {
  it('keeps automatic parallel tasks independent and rechecks revoked permission before cache hits', async () => {
    let enabled = true;
    const models: ChatModel[] = [
      {
        id: 'openai/gpt-6.1-sol',
        provider: 'openrouter',
        name: 'Sol',
        efforts: ['default', 'high'],
        contextTokens: 1000000,
        maxOutputTokens: 128000,
        imageInput: true,
        sshEligible: false,
        price: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5 },
      },
    ];
    const factory = createCompanionFactory({
      gateway: { profiles: buildProfiles({ light: 'l', standard: 's', heavy: 'h' }) } as never,
      modelCatalog: { get: async () => ({ models, updatedAt: 'now', unavailable: [] }) },
      memory: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      souls: {
        loadForUser: async () => [
          {
            key: 'core',
            kind: 'core',
            enabled: true,
            content: 'CORE',
            tokenEstimate: 1,
            priority: 0,
            userId: null,
          },
        ],
      } as never,
      loadSettings: async (user) => ({ skills: { maximize: user === 'u' && enabled } }),
    });
    const auth = {
      userId: 'u',
      companionName: 'Ernie',
      settings: {},
      scopes: [],
    } as unknown as AuthContext;
    const session = {
      id: 's',
      userId: 'u',
      contextTags: [],
      modelClass: 'standard',
    } as unknown as SessionRecord;
    const selection = {
      provider: 'openrouter' as const,
      modelId: models[0]!.id,
      effort: 'high' as const,
    };
    const manual = await factory.getCompanion(auth, session, selection);
    expect(manual?.profile.modelId).toBe(selection.modelId);
    expect(await factory.getCompanion(auth, session, selection)).toBe(manual);
    expect(
      (await factory.getCompanion(auth, { ...session, id: 'parallel' }))?.profile.modelId,
    ).toBe('auto');
    expect((await factory.getCompanion(auth, session))?.profile.modelId).toBe('auto');
    await expect(
      factory.getCompanion({ ...auth, userId: 'other' }, { ...session, id: 'other' }, selection),
    ).rejects.toThrow('disattivato');
    enabled = false;
    await expect(factory.getCompanion(auth, session, selection)).rejects.toThrow('disattivato');
  });
});
