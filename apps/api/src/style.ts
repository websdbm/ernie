import { type Pool, withUser } from '@ernie/db';
import { ConversationStyle, STYLE_PROFILES, styleOf } from '@ernie/soul';
import { defineTool } from '@ernie/tools';
import { z } from 'zod';

/**
 * Stile cambiato a voce o in chat (richiesta dell'utente, 16 ott 2026): «parlami in modo antico», «fai il
 * simpatico», «rispondi corto», «torna normale». Lo stile resta finché non lo cambia (anche dalle impostazioni) e
 * vale ovunque; l'agente della sessione si ricostruisce al turno dopo, intanto la risposta di conferma lo usa già.
 */
export interface StyleToolDeps {
  readonly pool: Pool;
  /** Ricostruisce gli agenti dell'utente con lo stile nuovo. */
  readonly onChanged: (userId: string) => void;
}

export async function setConversationStyle(
  pool: Pool,
  userId: string,
  style: ConversationStyle,
): Promise<void> {
  await withUser(pool, userId, (c) =>
    c.query(`UPDATE users SET settings = settings || $2::jsonb WHERE id = $1`, [
      userId,
      JSON.stringify({ conversationStyle: style }),
    ]),
  );
}

export function createStyleTool(deps: StyleToolDeps) {
  const list = STYLE_PROFILES.map((s) => `${s.id} (${s.description})`).join('; ');
  return defineTool({
    id: 'conversation_style_set',
    version: '1',
    category: 'settings',
    description: `Cambia il modo in cui parli all'utente, quando te lo chiede: «parlami in modo antico / da nobile», «fai lo spiritoso», «rispondi corto», «torna normale». Stili: ${list}. Lo stile resta finché l'utente non lo cambia (anche in Impostazioni › Come parla Ernie) e vale anche per notifiche, promemoria ed email. Dopo, conferma in una riga già nello stile nuovo.`,
    risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: true },
    timeoutMs: 5_000,
    inputSchema: z.object({ style: ConversationStyle }),
    outputSchema: z.object({ style: ConversationStyle, title: z.string(), howToSpeak: z.string() }),
    execute: async (input, ctx) => {
      await setConversationStyle(deps.pool, ctx.userId, input.style);
      deps.onChanged(ctx.userId);
      const profile = styleOf({ conversationStyle: input.style });
      return {
        style: profile.id,
        title: profile.title,
        howToSpeak:
          profile.instructions || 'Stile di sempre: cordiale e chiaro, senza effetti particolari.',
      };
    },
  });
}
