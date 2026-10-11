import type { GuidedSkill } from './types.js';

/**
 * Catalogo delle skill dell'utente: ciascuna ha un interruttore per utente (`users.settings.skills`),
 * i tool che le appartengono e, se guidata, le istruzioni per il modello.
 */
export interface SkillCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'deterministic' | 'guided';
  /** Tool che la skill porta con sé: spenta la skill, spariscono dal set del modello. */
  readonly tools: readonly string[];
  readonly examples: readonly string[];
  readonly defaultEnabled: boolean;
}

export const SKILL_CATALOG: readonly SkillCatalogEntry[] = [
  {
    id: 'shopping_list',
    title: 'Lista della spesa',
    description: 'Aggiunge, toglie e legge la lista della spesa, senza passare dal modello quando la frase è chiara.',
    kind: 'deterministic',
    tools: ['shopping_list_add', 'shopping_list_remove', 'shopping_list_get', 'shopping_list_clear'],
    examples: ['aggiungi due litri di latte', 'togli il pane', 'cosa c’è nella lista?'],
    defaultEnabled: true,
  },
  {
    id: 'ricette',
    title: 'Ricette',
    description:
      'Propone ricette come schede, le salva tra le tue, le ritrova e le affina con versioni successive.',
    kind: 'guided',
    tools: ['recipe_search', 'recipe_get', 'recipe_save', 'recipe_delete', 'present_recipes', 'web_search'],
    examples: ['cosa cucino stasera?', 'salva questa ricetta', 'mostrami le mie ricette', 'affina la carbonara con meno pepe'],
    defaultEnabled: true,
  },
];

export const RECIPES_SKILL_INSTRUCTIONS = [
  'Procedura «Ricette».',
  "1) Quando l'utente chiede cosa cucinare o cerca una ricetta, cerca prima tra le sue ricette salvate con recipe_search; se ne trovi di adatte, proponile e dillo.",
  '2) Se proponi ricette nuove (anche cercate sul web), mostrale con present_recipes: titolo, tempo, porzioni, ingredienti e passaggi; nel testo aggiungi solo un commento breve. Non salvarle da solo.',
  "3) Se l'utente chiede di salvare una ricetta, chiama recipe_save con tutti i campi; se chiede di cambiarla o affinarla, leggila con recipe_get, applica le modifiche e salva con recipe_save (stesso titolo: nasce una nuova versione) indicando il motivo in reason.",
  "4) Elimina una ricetta solo su richiesta esplicita (recipe_delete). Gli ingredienti mancanti si aggiungono alla lista solo se l'utente lo chiede.",
].join('\n');

/** Skill guidata «Ricette»: istruzioni nel turno quando il router la indica. */
export function createRecipesSkill(): GuidedSkill {
  const entry = SKILL_CATALOG.find((s) => s.id === 'ricette');
  if (!entry) throw new Error('catalogo: skill ricette mancante');
  return {
    id: entry.id,
    kind: 'guided',
    category: 'recipes',
    description: entry.description,
    examples: entry.examples,
    allowedTools: entry.tools,
    instructions: RECIPES_SKILL_INSTRUCTIONS,
    riskClass: 'low',
  };
}

/** Stato per utente: `settings.skills = { id: boolean }`; assente → valore predefinito della skill. */
export function enabledSkillIds(settings: Readonly<Record<string, unknown>> | undefined): Set<string> {
  const map = (settings?.skills ?? {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const s of SKILL_CATALOG) {
    const v = map[s.id];
    if (typeof v === 'boolean' ? v : s.defaultEnabled) out.add(s.id);
  }
  return out;
}

/** Tool appartenenti a skill spente: da togliere dal set del modello. */
export function disabledToolIds(settings: Readonly<Record<string, unknown>> | undefined): Set<string> {
  const enabled = enabledSkillIds(settings);
  const out = new Set<string>();
  for (const s of SKILL_CATALOG) if (!enabled.has(s.id)) for (const t of s.tools) out.add(t);
  // Un tool condiviso da una skill accesa resta disponibile.
  for (const s of SKILL_CATALOG) if (enabled.has(s.id)) for (const t of s.tools) out.delete(t);
  return out;
}
