import { describe, expect, it } from 'vitest';
import {
  availableSkillIds,
  createRecipesSkill,
  createTodoSkill,
  disabledToolIds,
  enabledSkillIds,
  SKILL_CATALOG,
} from './catalog.js';
import { SkillRegistry } from './registry.js';

describe('catalogo delle skill', () => {
  it('propone Todo fra le candidate anche per un programmino informale e breve', () => {
    const registry = new SkillRegistry();
    for (const entry of SKILL_CATALOG)
      registry.register({
        ...createTodoSkill(),
        id: entry.id,
        description: entry.description,
        examples: entry.examples,
      });
    expect(
      registry.candidates(
        "Ho tempo fino alle 8:30, quindi un'ora: vorrei pulire la cucina, leggere 10 pagine, lavarmi e verificare una cosa al computer. Mi fai un programmino veloce?",
      ),
    ).toContain('todo');
  });
  it('Ricette include la lettura YouTube, che rispetta comunque il blocco web del tutore', () => {
    expect(createRecipesSkill().allowedTools).toContain('youtube_read');
    expect(disabledToolIds({ skills: { ricette: false } }).has('youtube_read')).toBe(false);
    expect(disabledToolIds({ guardianBlockedTools: ['youtube_read'] }).has('youtube_read')).toBe(
      true,
    );
  });
  it('Ricette legge le foto anche con Documenti e Second Brain spenti, senza riattivare lo studio', () => {
    const settings = { skills: { documenti: false, second_brain: false, ricette: true } };
    const off = disabledToolIds(settings);
    expect(off.has('document_get')).toBe(false);
    expect(off.has('document_summarize')).toBe(true);
    expect(off.has('document_schema')).toBe(true);
    expect(
      disabledToolIds({ skills: { ...settings.skills, ricette: false } }).has('document_get'),
    ).toBe(true);
    expect(
      disabledToolIds({ ...settings, guardianBlockedTools: ['document_get'] }).has('document_get'),
    ).toBe(true);
  });

  it('senza impostazioni valgono i predefiniti; gli interruttori per utente li sovrascrivono', () => {
    expect([...enabledSkillIds(undefined)].sort()).toEqual([
      'diario',
      'documenti',
      'messaggi',
      'portami',
      'ricette',
      'ricordami',
      'second_brain',
      'sentinelle',
      'shopping_list',
      'todo',
    ]);
    expect([
      ...enabledSkillIds({
        skills: {
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          diario_personale: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
          messaggi: false,
          portami: false,
          todo: false,
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
          diario_personale: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
          messaggi: false,
          portami: false,
          todo: false,
        },
      }),
    ]).toEqual([]);
  });

  it('una skill non disponibile (impostazioni) non è attiva anche se accesa nel pannello', () => {
    expect([...availableSkillIds(undefined)].sort()).toEqual([
      'abitudini',
      'chat_archive',
      'diario',
      'diario_personale',
      'documenti',
      'maximize',
      'messaggi',
      'portami',
      'raindrop',
      'ricette',
      'ricordami',
      'salute',
      'second_brain',
      'sentinelle',
      'shopping_list',
      'ssh',
      'todo',
    ]);
    expect([
      ...availableSkillIds({
        skillsAvailable: {
          maximize: false,
          abitudini: false,
          raindrop: false,
          chat_archive: false,
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          diario_personale: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
          messaggi: false,
          portami: false,
          todo: false,
          ssh: false,
        },
      }),
    ]).toEqual(['shopping_list']);
    expect([
      ...enabledSkillIds({
        skillsAvailable: {
          chat_archive: false,
          ricette: false,
          documenti: false,
          ricordami: false,
          diario: false,
          diario_personale: false,
          sentinelle: false,
          second_brain: false,
          salute: false,
          messaggi: false,
          portami: false,
          todo: false,
          ssh: false,
        },
        skills: { ricette: true },
      }),
    ]).toEqual(['shopping_list']);
    // Resa disponibile di nuovo, torna attiva con l'interruttore che aveva.
    expect(
      [
        ...enabledSkillIds({
          skillsAvailable: {
            chat_archive: false,
            ricette: true,
            documenti: false,
            ricordami: false,
            diario: false,
            diario_personale: false,
            sentinelle: false,
            second_brain: false,
            salute: false,
            messaggi: false,
            portami: false,
            todo: false,
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
    // Salute e SSH richiedono attivazione esplicita.
    expect([...disabledToolIds(undefined)].sort()).toEqual([
      'health_open',
      'raindrop_collections',
      'raindrop_get',
      'raindrop_read',
      'raindrop_read_tools',
      'raindrop_save',
      'raindrop_search',
      'ssh_diagnose',
      'ssh_inventory',
      'ssh_investigate',
      'ssh_operation',
      'ssh_plan',
    ]);
    expect(disabledToolIds({ skills: { salute: true, ssh: true, raindrop: true } }).size).toBe(0);
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

describe('diario personale riservato', () => {
  it('è distinto dal riepilogo attività, opt-in e senza strumenti dell’agente', () => {
    const diary = SKILL_CATALOG.find((s) => s.id === 'diario_personale');
    expect(diary).toMatchObject({
      title: 'Diario personale',
      defaultEnabled: false,
      kind: 'deterministic',
      tools: [],
      examples: [],
    });
    expect(enabledSkillIds({}).has('diario_personale')).toBe(false);
    expect(enabledSkillIds({ skills: { diario_personale: true } }).has('diario_personale')).toBe(
      true,
    );
    expect(
      enabledSkillIds({
        skills: { diario_personale: true },
        skillsAvailable: { diario_personale: false },
      }).has('diario_personale'),
    ).toBe(false);
    expect(SKILL_CATALOG.find((s) => s.id === 'diario')?.title).toBe('Cosa ho fatto');
  });
});
