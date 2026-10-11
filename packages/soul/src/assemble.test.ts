import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assembleSoul, type Soul, SoulBudgetError } from './assemble.js';
import { CORE_SOUL_TOKEN_BUDGET, estimateTokens } from './tokens.js';

const soul = (p: Partial<Soul> & Pick<Soul, 'key' | 'kind' | 'content'>): Soul => ({
  id: p.id ?? p.key,
  userId: p.userId ?? null,
  tags: p.tags ?? [],
  version: p.version ?? 1,
  tokenEstimate: p.tokenEstimate ?? estimateTokens(p.content),
  enabled: p.enabled ?? true,
  locked: p.locked ?? false,
  ...p,
});

const globals: Soul[] = [
  soul({ key: 'core', kind: 'core', content: 'Sei Ernie, assistente di casa.' }),
  soul({
    key: 'ctx:cucina',
    kind: 'context',
    tags: ['cucina', 'spesa'],
    content: 'Contesto cucina.',
  }),
  soul({ key: 'ctx:lavoro', kind: 'context', tags: ['lavoro'], content: 'Contesto lavoro.' }),
  soul({ key: 'policy:voce', kind: 'policy', tags: ['voce'], content: 'Frasi brevi a voce.' }),
];

describe('assembleSoul', () => {
  it('è deterministico e include solo i context con tag attivi', () => {
    const a = assembleSoul({ souls: globals, contextTags: ['cucina'], companionName: 'Ernie' });
    const b = assembleSoul({
      souls: [...globals].reverse(),
      contextTags: ['cucina'],
      companionName: 'Ernie',
    });
    expect(a.instructions).toBe(b.instructions);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.instructions).toContain('Contesto cucina.');
    expect(a.instructions).not.toContain('Contesto lavoro.');
    expect(a.instructions).toContain('Frasi brevi a voce.');
    expect(a.used).toEqual(['core@1', 'ctx:cucina@1', 'policy:voce@1']);
  });

  it("il Soul dell'utente sostituisce il globale con la stessa chiave e il nome del companion viene applicato", () => {
    const mine = soul({
      key: 'core',
      kind: 'core',
      userId: 'u1',
      version: 3,
      content: 'Sei Ernie, il compagno di Leo.',
    });
    const out = assembleSoul({ souls: [...globals, mine], contextTags: [], companionName: 'Max' });
    expect(out.instructions.startsWith('Sei Max, il compagno di Leo.')).toBe(true);
    expect(out.used[0]).toBe('core@3');
  });

  it('rifiuta un Core Soul oltre il budget o assente', () => {
    const big = soul({
      key: 'core',
      kind: 'core',
      content: 'x'.repeat(CORE_SOUL_TOKEN_BUDGET * 3),
    });
    expect(() => assembleSoul({ souls: [big], contextTags: [], companionName: 'E' })).toThrowError(
      SoulBudgetError,
    );
    expect(() =>
      assembleSoul({ souls: [globals[1] as Soul], contextTags: [], companionName: 'E' }),
    ).toThrowError(SoulBudgetError);
  });

  it('il Core Soul seminato dalla migrazione 0005 rispetta il budget di 400 token', async () => {
    const sql = await readFile(
      new URL('../../../infrastructure/migrations/0005_seed_souls.sql', import.meta.url),
      'utf8',
    );
    const m = /\('core', 'core', NULL, '\{\}', 1,\n\$soul\$([\s\S]*?)\$soul\$/.exec(sql);
    expect(m?.[1]).toBeTruthy();
    const tokens = estimateTokens(m?.[1] ?? '');
    expect(tokens).toBeLessThanOrEqual(CORE_SOUL_TOKEN_BUDGET);
    expect(tokens).toBeGreaterThan(50);
  });
});
