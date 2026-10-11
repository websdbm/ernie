import { describe, expect, it } from 'vitest';
import { createRecipesSkill, disabledToolIds, enabledSkillIds, SKILL_CATALOG } from './catalog.js';

describe('catalogo delle skill', () => {
  it('senza impostazioni valgono i predefiniti; gli interruttori per utente li sovrascrivono', () => {
    expect([...enabledSkillIds(undefined)].sort()).toEqual(['ricette', 'shopping_list']);
    expect([...enabledSkillIds({ skills: { ricette: false } })]).toEqual(['shopping_list']);
    expect([...enabledSkillIds({ skills: { shopping_list: false, ricette: false } })]).toEqual([]);
  });

  it('i tool di una skill spenta spariscono, salvo quelli condivisi con una skill accesa', () => {
    const off = disabledToolIds({ skills: { ricette: false } });
    expect(off.has('recipe_save')).toBe(true);
    expect(off.has('present_recipes')).toBe(true);
    expect(off.has('shopping_list_add')).toBe(false);
    expect(disabledToolIds({ skills: { shopping_list: false } }).has('shopping_list_add')).toBe(
      true,
    );
    expect(disabledToolIds(undefined).size).toBe(0);
  });

  it('la skill guidata «Ricette» porta istruzioni e tool coerenti con il catalogo', () => {
    const s = createRecipesSkill();
    const entry = SKILL_CATALOG.find((x) => x.id === 'ricette');
    expect(s.allowedTools).toEqual(entry?.tools);
    expect(s.instructions).toMatch(/recipe_search/);
    expect(s.instructions).toMatch(/present_recipes/);
    expect(s.riskClass).toBe('low');
  });
});
