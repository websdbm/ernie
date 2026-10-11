import { RecipeItem } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool } from '../types.js';

/**
 * Tool di presentazione: nessun effetto, nessun dato privato. Il modello lo chiama per mostrare ricette
 * come schede native nell'app (blocco `recipes`, schema chiuso); il testo resta un commento breve.
 */
export const presentRecipesTool = defineTool({
  id: 'present_recipes',
  version: '1',
  category: 'presentation',
  description:
    "Mostra all'utente da una a sei ricette come schede (titolo, tempo, porzioni, ingredienti, passaggi, fonte). Usalo ogni volta che proponi ricette, poi aggiungi nel testo solo un commento breve.",
  risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: false },
  timeoutMs: 2_000,
  inputSchema: z.object({ recipes: z.array(RecipeItem).min(1).max(6) }),
  outputSchema: z.object({ shown: z.number().int() }),
  execute: async ({ recipes }) => ({ shown: recipes.length }),
  present: ({ recipes }) => ({ kind: 'recipes', recipes }),
});
