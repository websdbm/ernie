import { describe, expect, it } from 'vitest';
import {
  availableSkillIds,
  createRecipesSkill,
  disabledToolIds,
  enabledSkillIds,
  SKILL_CATALOG,
} from './catalog.js';

describe('catalogo delle skill', () => {
  it('senza impostazioni valgono i predefiniti; gli interruttori per utente li sovrascrivono', () => {
    expect([...enabledSkillIds(undefined)].sort()).toEqual([
      'diario',
      'documenti',
      'ricette',
      'ricordami',
      'second_brain',
      'sentinelle',
      'shopping_list',
    ]);
    expect([
      ...enabledSkillIds({
        skills: {
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
        },
      }),
    ]).toEqual(['shopping_list']);
    expect([
      ...enabledSkillIds({
        skills: {
          shopping_list: false,
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
        },
      }),
    ]).toEqual([]);
  });

  it('una skill non disponibile (impostazioni) non è attiva anche se accesa nel pannello', () => {
    expect([...availableSkillIds(undefined)].sort()).toEqual([
      'diario',
      'documenti',
      'ricette',
      'ricordami',
      'salute',
      'second_brain',
      'sentinelle',
      'shopping_list',
    ]);
    expect([
      ...availableSkillIds({
        skillsAvailable: {
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
        },
      }),
    ]).toEqual(['shopping_list']);
    expect([
      ...enabledSkillIds({
        skillsAvailable: {
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
        },
        skills: { ricette: true },
      }),
    ]).toEqual(['shopping_list']);
    // Resa disponibile di nuovo, torna attiva con l'interruttore che aveva.
    expect(
      [
        ...enabledSkillIds({
          skillsAvailable: {
            ricette: true,
            documenti: false,
            ricordami: false,
            diario: false,
            sentinelle: false,
            second_brain: false,
            salute: false,
          },
          skills: { ricette: true },
        }),
      ].sort(),
    ).toEqual(['ricette', 'shopping_list']);
    expect(disabledToolIds({ skillsAvailable: { ricette: false } }).has('recipe_save')).toBe(true);
  });

  it('i tool di una skill spenta spariscono, salvo quelli condivisi con una skill accesa', () => {
    const off = disabledToolIds({ skills: { ricette: false } });
    expect(off.has('recipe_save')).toBe(true);
    expect(off.has('present_recipes')).toBe(true);
    // web_search è di uso generale: la skill lo usa ma non lo possiede.
    expect(off.has('web_search')).toBe(false);
    expect(off.has('shopping_list_add')).toBe(false);
    expect(disabledToolIds({ skills: { shopping_list: false } }).has('shopping_list_add')).toBe(
      true,
    );
    // Di partenza è spenta solo «Salute» (dati sanitari): i suoi tool non arrivano al modello.
    expect([...disabledToolIds(undefined)].sort()).toEqual([
      'health_import',
      'health_overview',
      'health_parameter',
      'health_report',
    ]);
    expect(disabledToolIds({ skills: { salute: true } }).size).toBe(0);
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

describe('skill «Documenti»', () => {
  it('ha icona, micro-descrizione e tool coerenti con il catalogo', async () => {
    const { createDocumentsSkill } = await import('./catalog.js');
    const s = createDocumentsSkill();
    const entry = SKILL_CATALOG.find((x) => x.id === 'documenti');
    expect(entry?.icon).toBe('doc.text.viewfinder');
    expect(entry?.summary.length).toBeLessThan(80);
    expect(s.allowedTools).toEqual([
      'document_summarize',
      'document_schema',
      'document_get',
      'document_list',
      'document_search',
      'document_focus',
    ]);
    expect(s.instructions).toContain('document_summarize');
    for (const e of SKILL_CATALOG) expect(e.icon.length).toBeGreaterThan(0);
  });
});
