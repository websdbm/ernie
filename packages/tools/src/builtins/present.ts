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
  inputSchema: z.object({
    recipes: z
      .array(RecipeItem.omit({ recipeId: true }))
      .min(1)
      .max(6),
  }),
  outputSchema: z.object({ shown: z.number().int() }),
  execute: async ({ recipes }) => ({ shown: recipes.length }),
  present: ({ recipes }) => ({ kind: 'recipes', recipes }),
});

/**
 * Domanda chiusa (richiesta dell'utente, 15 ott 2026): quando la richiesta è ambigua tra funzioni diverse
 * (promemoria, sentinella, nota…) o manca un dato essenziale, il modello propone poche opzioni; l'app le mostra
 * come pulsanti e il tocco manda l'etichetta come messaggio. Il modello poi ricava il resto dalla frase originale.
 */
export const presentChoicesTool = defineTool({
  id: 'present_choices',
  version: '1',
  category: 'presentation',
  description:
    "Fai all'utente UNA domanda chiusa con da 2 a 4 opzioni brevi, mostrate come pulsanti. Usala quando la richiesta è ambigua tra funzioni diverse (es. «vuoi un promemoria, una sentinella o una nota nel second brain?») o manca un dato essenziale con poche alternative. Nel testo ripeti solo la domanda, senza elencare le opzioni. Alla risposta, ricava tutto il resto dal messaggio originale senza farlo ripetere.",
  risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: false },
  timeoutMs: 2_000,
  inputSchema: z.object({
    question: z.string().min(3).max(300),
    options: z
      .array(z.object({ label: z.string().min(1).max(80) }))
      .min(2)
      .max(4),
  }),
  outputSchema: z.object({ asked: z.boolean() }),
  execute: async () => ({ asked: true }),
  present: ({ question, options }) => ({
    kind: 'choices',
    question,
    options: options.map((o, i) => ({ id: String(i + 1), label: o.label })),
  }),
});
