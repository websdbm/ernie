import { describe, expect, it, vi } from 'vitest';
import type { CompanionFactoryDeps } from './companion.js';
import { createCompanionFactory } from './companion.js';

const build = vi.hoisted(() => vi.fn((input) => ({ profile: { modelId: 'unchanged' }, input })));
vi.mock('@ernie/agent-core', async (original) => ({
  ...(await original<object>()),
  createCompanionAgent: build,
}));

describe('cold start companion', () => {
  it('carica sei fonti in parallelo, conserva ordine del prefisso e riusa la cache', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const read = async <T>(name: string, value: T): Promise<T> => {
      started.push(name);
      await new Promise<void>((resolve) => release.push(resolve));
      return value;
    };
    const factory = createCompanionFactory({
      gateway: {} as never,
      memory: {} as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      souls: {
        loadForUser: () =>
          read('soul', [
            {
              key: 'core',
              kind: 'core',
              enabled: true,
              content: 'CORE',
              tokenEstimate: 1,
              priority: 0,
              userId: null,
            },
          ]),
      } as never,
      profiles: { get: () => read('profile', null) } as never,
      memories: { listActiveSemantic: () => read('memories', []) } as never,
      family: { list: () => read('family', [{ label: 'Giulia', relation: 'compagna' }]) },
      loadSettings: () => read('settings', {}),
      lexicon: {
        learningEnabled: () => read('lexicon', false),
        listActive: vi.fn(),
      } as NonNullable<CompanionFactoryDeps['lexicon']>,
    });
    const auth = { userId: 'u', companionName: 'Ernie', settings: {}, scopes: [] } as never;
    const session = { id: 's', contextTags: [], modelClass: 'standard' } as never;
    const pending = factory.getCompanion(auth, session);
    try {
      await vi.waitFor(() => expect(started).toHaveLength(6));
      expect(build).not.toHaveBeenCalled();
      for (const done of release.reverse()) done();
      const first = await pending;
      expect(first).toBe(await factory.getCompanion(auth, session));
      expect(started).toHaveLength(6);
      expect(build).toHaveBeenCalledTimes(1);
      expect(build.mock.calls[0]?.[0].memorySnapshot).toContain('Giulia (compagna)');
    } finally {
      for (const done of release) done();
    }
  });
});
