import type { Memory } from '@ernie/agent-core';
import type { Logger } from '@ernie/observability';
import type { LearnedSkillRepository } from '@ernie/skills';
import { createRecipesSkill, createShoppingListSkill } from '@ernie/skills';
import type { SoulRepository } from '@ernie/soul';
import { describe, expect, it } from 'vitest';
import { createCompanionFactory } from './companion.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as unknown as Logger;

const learned = {
  loadActiveGuided: async () => [],
} as unknown as LearnedSkillRepository;

const shopping = {
  list: async () => [],
  add: async () => [],
  remove: async () => [],
  clear: async () => 0,
} as unknown as Parameters<typeof createShoppingListSkill>[0];

describe('skill per utente a metà conversazione', () => {
  it('usa le impostazioni correnti dal database e, dopo invalidateUser, aggiorna il registry senza nuova sessione', async () => {
    let settings: Record<string, unknown> = { skills: { ricette: false } };
    let loads = 0;
    const factory = createCompanionFactory({
      gateway: null,
      memory: {} as Memory,
      souls: {} as SoulRepository,
      logger,
      skills: { builtin: [createShoppingListSkill(shopping), createRecipesSkill()], learned },
      loadSettings: async () => {
        loads++;
        return settings;
      },
    });
    // La foto dell'AuthContext dice il contrario: vince il database.
    const auth = { userId: 'u1', settings: { skills: { ricette: true } } };
    const before = await factory.skillsFor(auth);
    expect(before.list().map((s) => s.id)).toEqual(['shopping_list']);
    expect(loads).toBe(1);

    // Cache: nessun nuovo caricamento finché non cambia qualcosa.
    await factory.skillsFor(auth);
    expect(loads).toBe(1);

    settings = { skills: { ricette: true } };
    factory.invalidateUser('u1');
    const after = await factory.skillsFor(auth);
    expect(after.list().map((s) => s.id)).toEqual(['ricette', 'shopping_list']);
    expect(loads).toBe(2);
  });

  it('senza caricatore usa le impostazioni della sessione', async () => {
    const factory = createCompanionFactory({
      gateway: null,
      memory: {} as Memory,
      souls: {} as SoulRepository,
      logger,
      skills: { builtin: [createShoppingListSkill(shopping), createRecipesSkill()], learned },
    });
    const registry = await factory.skillsFor({
      userId: 'u2',
      settings: { skills: { shopping_list: false } },
    });
    expect(registry.list().map((s) => s.id)).toEqual(['ricette']);
  });
});
