import type { Memory } from '@ernie/agent-core';
import type { Logger } from '@ernie/observability';
import type { LearnedSkillRepository } from '@ernie/skills';
import { createRecipesSkill, createShoppingListSkill } from '@ernie/skills';
import type { SoulRepository } from '@ernie/soul';
import { describe, expect, it, vi } from 'vitest';
import { createCompanionFactory, supervisedNote } from './companion.js';

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
  it('starts settings and learned reads together and shares them across simultaneous tasks', async () => {
    const started: string[] = [];
    let settingsReady: (value: Record<string, unknown>) => void = () => {};
    let skillsReady: () => void = () => {};
    const factory = createCompanionFactory({
      gateway: null,
      memory: {} as Memory,
      souls: {} as SoulRepository,
      logger,
      loadSettings: async () => {
        started.push('settings');
        return new Promise<Record<string, unknown>>((resolve) => {
          settingsReady = resolve;
        });
      },
      skills: {
        builtin: [createShoppingListSkill(shopping), createRecipesSkill()],
        learned: {
          loadActiveGuided: async () => {
            started.push('skills');
            await new Promise<void>((resolve) => {
              skillsReady = resolve;
            });
            return [];
          },
        } as unknown as LearnedSkillRepository,
      },
    });
    const auth = { userId: 'parallel-user', settings: {} };
    const one = factory.skillsFor(auth),
      two = factory.skillsFor(auth);
    await vi.waitFor(() => expect(started.sort()).toEqual(['settings', 'skills']));
    settingsReady({ skills: { ricette: false } });
    skillsReady();
    expect(await one).toBe(await two);
    expect((await one).list().map((skill) => skill.id)).toEqual(['shopping_list']);
    expect(started).toHaveLength(2);
  });

  it('does not repopulate revoked settings or skill cache from an older pending load', async () => {
    let oldReady: (value: Record<string, unknown>) => void = () => {};
    const loadSettings = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldReady = resolve;
          }),
      )
      .mockResolvedValue({ skills: { ricette: false } });
    const factory = createCompanionFactory({
      gateway: null,
      memory: {} as Memory,
      souls: {} as SoulRepository,
      logger,
      loadSettings,
      skills: { builtin: [createRecipesSkill()], learned },
    });
    const auth = { userId: 'changing-user', settings: { skills: { ricette: true } } };
    const old = factory.skillsFor(auth);
    await vi.waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(1));
    factory.invalidateUser(auth.userId);
    const fresh = await factory.skillsFor(auth);
    expect(fresh.list()).toEqual([]);
    oldReady({ skills: { ricette: true } });
    expect(await old).toBe(fresh);
    expect((await factory.skillsFor(auth)).list()).toEqual([]);
    expect(loadSettings).toHaveBeenCalledTimes(2);
  });

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

describe('nota per un account seguito', () => {
  it('ragazzo: contenuti adatti all’età; nonna e nonno: tono fra adulti, con il genere giusto', () => {
    const kid = supervisedNote('figlio', ['Ricette']);
    expect(kid).toContain('adatti alla sua età');
    expect(kid).toContain('Funzioni spente dal genitore: Ricette');
    expect(supervisedNote(undefined, [])).toContain('ragazzo');
    const nonna = supervisedNote('nonna', ['ricerca sul web']);
    expect(nonna).toContain('una nonna seguita');
    expect(nonna).toContain('chi la segue');
    expect(nonna).not.toContain('età');
    expect(supervisedNote('nonno', [])).toMatch(
      /^Questo account è di un nonno seguito .*pazienza\.$/,
    );
  });
});
