/**
 * Router deterministico: comandi riconosciuti che non richiedono né Jev né un modello.
 * In M5 si aggiungono le procedure consolidate (skill deterministiche).
 */
export interface CommandContext {
  readonly companionName: string;
  readonly modelClass: 'light' | 'standard' | 'heavy';
  readonly contextTags: readonly string[];
  readonly spentTodayUsd: number;
  readonly budgetUsd: number;
  readonly role: 'owner' | 'member';
}

export type CommandResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'set_class'; readonly modelClass: 'standard' | 'heavy'; readonly text: string }
  | { readonly kind: 'set_context'; readonly tags: readonly string[]; readonly text: string };

const TAG_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const CLASS_RANK = { light: 0, standard: 1, heavy: 2 } as const;

export const COMMANDS_HELP = [
  '/aiuto — questo elenco',
  '/stato — sessione, classe di modello, contesto e spesa di oggi',
  '/classe standard|heavy — classe di modello della sessione (heavy resta finché non scrivi /classe standard)',
  '/contesto <tag …> | nessuno — contesti attivi della sessione (es. cucina)',
].join('\n');

export function isCommand(text: string): boolean {
  return /^\s*\//.test(text);
}

export function routeCommand(text: string, ctx: CommandContext): CommandResult {
  if (!isCommand(text)) return { kind: 'none' };
  const [cmd = '', ...args] = text.trim().slice(1).split(/\s+/);
  switch (cmd.toLowerCase()) {
    case 'aiuto':
    case 'help':
      return { kind: 'reply', text: `Comandi di ${ctx.companionName}:\n${COMMANDS_HELP}` };
    case 'stato': {
      const tags = ctx.contextTags.length ? ctx.contextTags.join(', ') : 'nessuno';
      const budget =
        ctx.budgetUsd > 0
          ? `${ctx.spentTodayUsd.toFixed(4)} di ${ctx.budgetUsd.toFixed(2)} USD`
          : `${ctx.spentTodayUsd.toFixed(4)} USD (nessun tetto)`;
      return {
        kind: 'reply',
        text: `Classe di modello: ${ctx.modelClass}. Contesti: ${tags}. Spesa di oggi: ${budget}.`,
      };
    }
    case 'classe': {
      const target = (args[0] ?? '').toLowerCase();
      if (target === 'light')
        return {
          kind: 'reply',
          text: 'La classe light serve solo ai lavori di servizio (riassunti, memoria), non alla conversazione.',
        };
      if (target !== 'standard' && target !== 'heavy')
        return { kind: 'reply', text: 'Uso: /classe standard oppure /classe heavy' };
      // heavy chiesto a mano resta fisso (anche se la sessione c'era già arrivata da sola); standard lo toglie.
      if (target === 'standard' && CLASS_RANK[ctx.modelClass] <= CLASS_RANK.standard)
        return { kind: 'reply', text: 'La sessione è già in classe standard.' };
      return {
        kind: 'set_class',
        modelClass: target,
        text:
          target === 'heavy'
            ? 'Classe di modello heavy per questa sessione, finché non scrivi /classe standard.'
            : 'Classe di modello riportata a standard per questa sessione.',
      };
    }
    case 'contesto': {
      if (args.length === 0)
        return { kind: 'reply', text: 'Uso: /contesto cucina [altro…] oppure /contesto nessuno' };
      if (args.length === 1 && args[0]?.toLowerCase() === 'nessuno')
        return { kind: 'set_context', tags: [], text: 'Nessun contesto attivo.' };
      const tags = [...new Set(args.map((a) => a.toLowerCase()))];
      const bad = tags.filter((t) => !TAG_RE.test(t));
      if (bad.length)
        return {
          kind: 'reply',
          text: `Tag non validi: ${bad.join(', ')} (lettere, numeri, trattini).`,
        };
      return { kind: 'set_context', tags, text: `Contesti attivi: ${tags.join(', ')}.` };
    }
    default:
      return { kind: 'reply', text: `Comando sconosciuto: /${cmd}. Scrivi /aiuto per l'elenco.` };
  }
}
