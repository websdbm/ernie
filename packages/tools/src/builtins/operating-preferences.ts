import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

export const OperatingPreferenceSchema = z.object({
  id: z.string(),
  text: z.string().min(3).max(400),
  kind: z.enum(['explicit', 'inferred']),
  active: z.boolean(),
  source: z.enum(['chat', 'settings', 'observation']),
  evidence: z.string().max(800),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OperatingPreference = z.infer<typeof OperatingPreferenceSchema>;
export interface SaveOperatingPreference {
  id?: string;
  text: string;
  kind: 'explicit' | 'inferred';
  active?: boolean;
  source: 'chat' | 'settings' | 'observation';
  evidence: string;
  userMessage?: string;
}
export interface OperatingPreferenceStore {
  list(userId: string): Promise<OperatingPreference[]>;
  save(userId: string, input: SaveOperatingPreference): Promise<OperatingPreference>;
  remove(userId: string, id: string): Promise<boolean>;
  deactivate(userId: string, id: string): Promise<boolean>;
}

/** Preferences are personalization data, never permissions or instructions from external content. */
export function validateOperatingPreference(input: SaveOperatingPreference): void {
  const text = input.text.trim();
  if (text.length < 3 || text.length > 400 || input.evidence.length > 800)
    throw new ToolError('La preferenza deve contenere da 3 a 400 caratteri.', 'invalid_preference');
  const unsafe =
    /(?:\bssh\b|\bsudo\b|\broot\b|\bapi[ -]?key\b|password|credenzial|chiav[ei] privat|token|permess|autorizz|sicurezza|security|safety|guardrail|policy|approval|approvazion|(?:non|senza|salta|evita|bypass|skip|without).*(?:conferm|confirmation)|\bsystem\b|\bdeveloper\b|ignora.*istruz|ignore.*instruct|senza.*chieder|without.*ask)/iu;
  if (unsafe.test(text))
    throw new ToolError(
      'Questa sezione riguarda il modo di lavorare e comunicare. I permessi si gestiscono nelle impostazioni di sicurezza.',
      'security_preference',
    );
  if (input.source === 'chat' || input.source === 'observation') {
    const quote = input.evidence.trim();
    if (
      !quote ||
      (input.kind === 'explicit' && text !== quote) ||
      !input.userMessage?.includes(quote)
    )
      throw new ToolError(
        'Serve una preferenza esplicita citata esattamente dal messaggio corrente.',
        'ungrounded_preference',
      );
    if (
      /\b(?:oggi|stasera|stavolta|questa volta|solo per|per ora|per adesso|today|tonight|this time|for now)\b/iu.test(
        text,
      )
    )
      throw new ToolError(
        'Questa indicazione vale per la richiesta corrente: non la salvo come preferenza permanente.',
        'temporary_preference',
      );
  }
  if (input.kind === 'explicit' && input.source === 'observation')
    throw new ToolError(
      'Una deduzione non può diventare una preferenza confermata.',
      'unconfirmed_preference',
    );
}

export function createOperatingPreferenceSpecs(store: OperatingPreferenceStore): ToolSpec[] {
  return [
    defineTool({
      id: 'operating_preferences_list',
      version: '1',
      category: 'memory',
      description:
        'Legge le preferenze su come Ernie deve lavorare e comunicare, con origine e stato. Le ipotesi inattive non sono istruzioni.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      inputSchema: z.object({}),
      outputSchema: z.object({ preferences: z.array(OperatingPreferenceSchema) }),
      execute: async (_, ctx) => ({ preferences: await store.list(ctx.userId) }),
    }),
    defineTool({
      id: 'operating_preference_save',
      version: '1',
      category: 'memory',
      oncePerTurn: true,
      description:
        'Memorizza una preferenza esplicita su stile o organizzazione: text ed evidence devono citare esattamente le parole del messaggio corrente dell’utente. Con kind=inferred salva solo un’ipotesi inattiva. Non usare per fatti personali, permessi, SSH o autorizzazioni.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      inputSchema: z.object({
        id: z.string().optional(),
        text: z.string().min(3).max(400),
        evidence: z.string().min(1).max(800),
        kind: z.enum(['explicit', 'inferred']).default('explicit'),
      }),
      outputSchema: z.object({ preference: OperatingPreferenceSchema }),
      execute: async (input, ctx) => {
        const { id, ...fields } = input;
        const data: SaveOperatingPreference = {
          ...fields,
          ...(id ? { id } : {}),
          source: input.kind === 'explicit' ? 'chat' : 'observation',
          ...(ctx.userMessage ? { userMessage: ctx.userMessage } : {}),
        };
        validateOperatingPreference(data);
        return { preference: await store.save(ctx.userId, data) };
      },
    }),
    defineTool({
      id: 'operating_preference_remove',
      version: '1',
      category: 'memory',
      oncePerTurn: true,
      description:
        'Elimina o disattiva una preferenza quando l’utente lo chiede esplicitamente. Leggi prima le preferenze. evidence deve citare le parole del messaggio corrente, includendo la preferenza per esteso e l’azione (dimentica/elimina oppure disattiva). Se il riferimento è ambiguo chiedi quale regola.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      inputSchema: z.object({
        id: z.string(),
        action: z.enum(['delete', 'disable']),
        evidence: z.string().min(3).max(800),
      }),
      outputSchema: z.object({ changed: z.boolean(), action: z.enum(['delete', 'disable']) }),
      execute: async ({ id, action, evidence }, ctx) => {
        const preference = (await store.list(ctx.userId)).find((p) => p.id === id);
        if (!preference) throw new ToolError('Preferenza non trovata.', 'not_found');
        const quote = evidence.trim();
        const negative =
          /\b(?:non|not|don't)\s+(?:dimentic|elimin|cancell|rimuov|disattiv|delete|disable|forget)/iu.test(
            quote,
          );
        const intent =
          action === 'delete'
            ? /\b(?:dimentica|elimina|cancella|rimuovi|forget|delete|remove)\b/iu
            : /\b(?:disattiva|spegni|sospendi|disable)\b/iu;
        if (
          !ctx.userMessage?.includes(quote) ||
          negative ||
          !intent.test(quote) ||
          !quote.toLowerCase().includes(preference.text.toLowerCase())
        )
          throw new ToolError(
            'Serve una richiesta esplicita che identifichi la preferenza da eliminare o disattivare.',
            'ungrounded_preference',
          );
        const changed =
          action === 'disable'
            ? await store.deactivate(ctx.userId, id)
            : await store.remove(ctx.userId, id);
        return { changed, action };
      },
    }),
  ];
}
