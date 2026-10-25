import type { PolicyVerdict } from '@ernie/agent-core';
import {
  type ConfirmationPresentation,
  ReminderRepeatInput,
  repeatLabel,
  toolDisplayName,
} from '@ernie/protocol';

/** Motivi interni conservati nell'audit; al cliente arriva una spiegazione comprensibile. */
export function confirmationReason(verdict: Extract<PolicyVerdict, { kind: 'ask' }>): string {
  if (verdict.exfiltration)
    return 'Questa azione invia informazioni a un servizio esterno. Controlla quali dati verranno condivisi prima di confermare.';
  if (verdict.reason.includes('contaminata'))
    return 'Prima di procedere, controlla i dati ricavati dai contenuti che ho letto.';
  if (verdict.reason.includes('sempre richiesta'))
    return 'Per questa azione è prevista la tua conferma.';
  return 'Questa azione richiede la tua conferma prima di procedere.';
}

const labels: Readonly<Record<string, string>> = {
  title: 'Titolo',
  ingredients: 'Ingredienti',
  steps: 'Preparazione',
  time: 'Tempo',
  servings: 'Porzioni',
  source: 'Fonte',
  url: 'Pagina web',
  notes: 'Note',
  tags: 'Tag',
  category: 'Categoria',
  reason: 'Modifica richiesta',
  recipe: 'Ricetta',
  text: 'Testo',
  at: 'Quando avvisarti',
  eventAt: 'Appuntamento',
  alarm: 'Sveglia',
  email: 'Avviso anche via email',
  forLabel: 'Per chi',
  place: 'Luogo',
  label: 'Nome',
  on: 'Quando',
  repeat: 'Ripeti',
  address: 'Indirizzo',
  here: 'Usa la posizione attuale',
  from: 'Nome attuale',
  to: 'Nuovo nome',
  into: 'Scheda finale',
  body: 'Contenuto',
  type: 'Tipo',
  mode: 'Operazione',
  refersFrom: 'Dal giorno',
  refersTo: 'Al giorno',
  hereAndNow: 'Usa la posizione attuale',
  links: 'Schede collegate',
  private: 'Riservata',
  spoken: 'Dettata a voce',
  concepts: 'Pagine collegate da creare',
  items: 'Prodotti',
  names: 'Prodotti',
  name: 'Nome',
  quantity: 'Quantità',
  list: 'Lista',
  checked: 'Segna come acquistati',
  restore: 'Ripristina',
  id: 'Riferimento',
  what: 'Cosa controllare',
  condition: 'Quando avvisarti',
  frequency: 'Frequenza',
  once: 'Termina dopo il primo avviso',
  query: 'Testo della ricerca',
  limit: 'Numero di risultati',
  offset: 'A partire dal risultato',
  documentId: 'Documento',
  scope: 'Ambito',
};
const choices: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  on: { arrive: 'Quando arrivi', leave: 'Quando esci' },
  frequency: { ogni_ora: 'Ogni ora', ogni_giorno: 'Ogni giorno', ogni_settimana: 'Ogni settimana' },
  mode: {
    create: 'Crea una nuova scheda',
    append: 'Aggiungi al contenuto esistente',
    replace: 'Sostituisci il contenuto',
    bought: 'Segna tutti come acquistati',
    empty: 'Svuota tutta la lista',
    bought_only: 'Rimuovi solo i prodotti acquistati',
  },
};

export function confirmationPresentation(
  toolId: string,
  input: unknown,
  timezone?: string,
): ConfirmationPresentation {
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const quoted = (key: string) =>
    text(key) ? `«${text(key).slice(0, 160)}»` : 'l’elemento indicato';
  let title = 'Confermi questa azione?';
  let summary = toolDisplayName(toolId);
  let confirmLabel = 'Conferma';
  let destructive = false;
  switch (toolId) {
    case 'recipe_save':
      title = 'Salvare questa ricetta?';
      summary = `${quoted('title')} verrà salvata nella tua raccolta. Se il titolo esiste già, la ricetta verrà aggiornata.`;
      confirmLabel = 'Salva ricetta';
      break;
    case 'recipe_delete':
      title = 'Eliminare questa ricetta?';
      summary = `Rimuovi ${quoted('recipe')} dalla tua raccolta.`;
      confirmLabel = 'Elimina ricetta';
      destructive = true;
      break;
    case 'shopping_list_add':
      title = 'Aggiungere alla lista?';
      summary = `Aggiungi i prodotti elencati ${text('list') ? `a ${quoted('list')}` : 'alla lista della spesa'}.`;
      confirmLabel = 'Aggiungi';
      break;
    case 'shopping_list_remove':
      title = 'Rimuovere questi prodotti?';
      confirmLabel = 'Rimuovi';
      destructive = true;
      break;
    case 'shopping_list_delete':
      title = 'Eliminare questa lista?';
      summary = `Elimina ${quoted('list')} e tutti i suoi prodotti.`;
      confirmLabel = 'Elimina lista';
      destructive = true;
      break;
    case 'reminder_create':
      title = 'Creare questo promemoria?';
      summary = text('text') || summary;
      confirmLabel = 'Crea promemoria';
      break;
    case 'reminder_cancel':
      title = 'Annullare questo promemoria?';
      confirmLabel = 'Annulla promemoria';
      destructive = true;
      break;
    case 'place_set':
      title = 'Salvare questo luogo?';
      summary = `${quoted('label')} verrà salvato tra i tuoi luoghi.`;
      confirmLabel = 'Salva luogo';
      break;
    case 'place_rename':
      title = 'Rinominare questo luogo?';
      summary = `${quoted('from')} diventerà ${quoted('to')}.`;
      confirmLabel = 'Rinomina';
      break;
    case 'brain_write':
      title = 'Aggiornare il Second Brain?';
      summary = `${quoted('title')}: ${choices.mode?.[text('mode')] ?? 'salva il contenuto indicato'}.`;
      confirmLabel = 'Salva nella scheda';
      break;
    case 'brain_merge':
      title = 'Unire queste schede?';
      summary = `Riunisci le schede elencate in ${quoted('into')}.`;
      confirmLabel = 'Unisci schede';
      break;
    case 'brain_knowledge_update':
      title = 'Aggiornare informazioni e orari?';
      summary = `Aggiorna la scheda ${quoted('ref')}, conservando lo storico. Non vengono create notifiche.`;
      confirmLabel = 'Aggiorna scheda';
      break;
    case 'web_search':
      title = 'Inviare questa ricerca?';
      summary = 'Il testo della ricerca verrà inviato al servizio di ricerca sul web.';
      confirmLabel = 'Cerca sul web';
      break;
    case 'web_fetch':
      title = 'Leggere questa pagina?';
      summary = 'L’indirizzo della pagina verrà inviato al servizio di lettura web.';
      confirmLabel = 'Leggi pagina';
      break;
  }
  let incomplete = false;
  const render = (value: unknown, key: string, depth = 0): string => {
    if (depth > 6) {
      incomplete = true;
      return 'Contenuto troppo articolato per questa anteprima.';
    }
    if (typeof value === 'string') {
      if (key === 'at' || key === 'eventAt') {
        if (Number.isFinite(Date.parse(value))) {
          try {
            return new Intl.DateTimeFormat('it-IT', {
              dateStyle: 'long',
              timeStyle: 'short',
              timeZone: timezone || 'Europe/Rome',
            }).format(new Date(value));
          } catch {
            /* Conserva la data originale se il fuso non è valido. */
          }
        }
      }
      return choices[key]?.[value] ?? value;
    }
    if (typeof value === 'boolean') return value ? 'Sì' : 'No';
    if (value === null || value === undefined) return 'Non indicato';
    if (Array.isArray(value)) {
      return (
        value
          .map(
            (item, index) =>
              `${key === 'steps' ? `${index + 1}.` : '•'} ${render(item, '', depth + 1)}`,
          )
          .join('\n') || 'Nessuno'
      );
    }
    if (typeof value === 'object') {
      const object = value as Record<string, unknown>;
      // Ricorrenza dei promemoria: «ogni lunedì e giovedì alle 18:30», non «Dettaglio: 1 • 4».
      if (key === 'repeat') {
        const repeat = ReminderRepeatInput.safeParse(object);
        if (repeat.success) {
          const { weekdays, day, ...rest } = repeat.data;
          return repeatLabel({
            ...rest,
            ...(weekdays ? { weekdays } : {}),
            ...(day !== undefined ? { day } : {}),
          });
        }
      }
      if (
        typeof object.name === 'string' &&
        Object.keys(object).every((k) => k === 'name' || k === 'quantity')
      )
        return `${object.name}${object.quantity ? ` · ${object.quantity}` : ''}`;
      return Object.entries(object)
        .map(([k, v]) => `${labels[k] ?? 'Dettaglio'}: ${render(v, k, depth + 1)}`)
        .join('\n');
    }
    return String(value);
  };
  let remaining = 90_000;
  const entries = Object.entries(args);
  if (entries.length > 32) incomplete = true;
  const details = entries.slice(0, 32).map(([key, value]) => {
    const full = render(value, key);
    const max = Math.min(65_000, remaining);
    const shown = full.slice(0, max);
    remaining -= shown.length;
    if (shown.length < full.length) incomplete = true;
    return {
      label:
        toolId === 'brain_merge' && key === 'notes'
          ? 'Schede da unire'
          : (labels[key] ?? 'Dettaglio'),
      value: shown,
    };
  });
  return {
    title,
    summary,
    confirmLabel,
    details,
    destructive,
    ...(incomplete ? { incomplete: true } : {}),
  };
}
