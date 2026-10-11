/** Preset di automazioni (UC-1): proposta settimanale di ricette e promemoria serale della lista. */
export const AUTOMATION_PRESETS: Record<string, Record<string, unknown>> = {
  'weekly-recipes': {
    key: 'ricette_settimana',
    title: 'Ricette della settimana',
    trigger: { type: 'cron', pattern: '0 10 * * 6' },
    timezone: 'Europe/Rome',
    jitterSeconds: 300,
    budgetUsd: 0.15,
    catchUp: 'latest',
    action: {
      type: 'guided',
      modelClass: 'standard',
      contextTags: ['cucina'],
      allowedTools: ['memory_search', 'shopping_list_get', 'web_search', 'shopping_list_add'],
      instructions: [
        'Prepara la proposta settimanale di ricette per l’utente.',
        '1) Con memory_search cerca le sue abitudini alimentari e preferenze (cosa compra spesso, cosa evita, allergie).',
        '2) Con shopping_list_get leggi la lista della spesa attuale.',
        '3) Con web_search trova 3 ricette per la settimana coerenti con le abitudini, variando i piatti; per ciascuna riporta titolo, fonte (URL) e ingredienti principali.',
        '4) Individua gli ingredienti che mancano rispetto alla lista e aggiungili con UNA sola chiamata a shopping_list_add; se il tool risponde che l’azione è in attesa di approvazione, va bene così: non ripeterla.',
        'Chiudi con un riepilogo di 5–8 righe: le tre ricette e gli ingredienti proposti.',
      ].join('\n'),
    },
  },
  'daily-list': {
    key: 'lista_sera',
    title: 'Promemoria lista della spesa',
    trigger: { type: 'cron', pattern: '0 18 * * *' },
    timezone: 'Europe/Rome',
    jitterSeconds: 60,
    budgetUsd: 0,
    action: { type: 'skill', skillId: 'shopping_list', input: 'cosa c’è nella lista della spesa?' },
  },
};
