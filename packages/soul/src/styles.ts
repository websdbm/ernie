import { z } from 'zod';

/**
 * Stili di conversazione (richiesta dell'utente, 16 ott 2026): la cornice di come parla Ernie, scelta nelle
 * impostazioni o a voce («parlami in modo antico», «torna normale») e valida ovunque: chat, voce, notifiche,
 * promemoria, email. Il colore lo danno le espressioni imparate dalla persona (lessico, vedi `lexiconNote`).
 * Profili scelti dall'utente: Neutro (predefinito), Scherzoso, Essenziale, Antico.
 */
export const ConversationStyle = z.enum(['neutro', 'scherzoso', 'essenziale', 'antico']);
export type ConversationStyle = z.infer<typeof ConversationStyle>;

export interface StyleProfile {
  readonly id: ConversationStyle;
  readonly title: string;
  /** Una riga per le impostazioni. */
  readonly description: string;
  /** Come suonerebbe la conferma di un promemoria: anteprima nelle impostazioni. */
  readonly example: string;
  /** Istruzioni per il modello; vuote per lo stile di sempre. */
  readonly instructions: string;
}

export const STYLE_PROFILES: readonly StyleProfile[] = [
  {
    id: 'neutro',
    title: 'Neutro',
    description: 'Il modo di parlare di sempre: cordiale e chiaro.',
    example: 'Fatto: domani alle 8 ti ricordo la riunione.',
    instructions: '',
  },
  {
    id: 'scherzoso',
    title: 'Scherzoso',
    description: 'Allegro e ironico, con qualche battuta quando ci sta.',
    example: 'Fatto! Domani alle 8 ti ricordo la riunione: niente scuse, io non dormo mai.',
    instructions:
      'Stile scherzoso: tono allegro e ironico, battute leggere e giochi di parole quando ci stanno, qualche esagerazione simpatica. Le informazioni pratiche (orari, date, numeri, nomi, istruzioni) restano esatte e facili da trovare. Niente battute su temi delicati (salute, lutti, preoccupazioni serie, urgenze): lì torni gentile e serio.',
  },
  {
    id: 'essenziale',
    title: 'Essenziale',
    description: 'Risposte brevissime, solo il necessario.',
    example: 'Promemoria: domani, 8:00, riunione.',
    instructions:
      "Stile essenziale: risposte brevissime con la sola informazione richiesta, senza premesse, saluti, riassunti di ciò che l'utente ha detto o domande di cortesia. Frasi corte; elenchi solo se servono. Se l'utente chiede spiegazioni dalle, ma asciutte.",
  },
  {
    id: 'antico',
    title: 'Antico',
    description: 'Un nobile erudito d’altri tempi, con parole arcaiche.',
    example: 'Sia fatto, vossignoria: all’alba di domani, alle ore otto, vi rammenterò l’adunanza.',
    instructions:
      'Stile antico: parli come un nobile erudito d’altri tempi, con lessico arcaico e forbito («orsù», «invero», «codesto», «giammai», «vossignoria», «mi pregio di…», «sia fatto», «rammentare», «desinare»), periodi eleganti e un pizzico di solennità teatrale; dai del voi o della vossignoria. Le informazioni pratiche (orari, date, numeri, nomi, indirizzi, istruzioni) restano chiare ed esatte, in forma moderna dove serve a capirle. Su temi delicati o urgenti resti forbito ma sobrio.',
  },
];

export const DEFAULT_STYLE: ConversationStyle = 'neutro';

/** Stile dalle impostazioni dell'utente; un valore sconosciuto vale come Neutro. */
export function styleOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): StyleProfile {
  const parsed = ConversationStyle.safeParse(settings?.conversationStyle);
  const id = parsed.success ? parsed.data : DEFAULT_STYLE;
  return STYLE_PROFILES.find((s) => s.id === id) ?? (STYLE_PROFILES[0] as StyleProfile);
}

/**
 * Nota di stile per un modello che scrive all'utente (conversazione, titoli dei promemoria, avvisi, email).
 * Vuota per lo stile Neutro: il prompt resta quello di sempre.
 */
export function styleNote(settings: Readonly<Record<string, unknown>> | null | undefined): string {
  const s = styleOf(settings);
  if (!s.instructions) return '';
  return `${s.instructions} Lo stile l'ha scelto l'utente (lo cambia a voce o in Impostazioni › Come parla Ernie); non usare mai parolacce o volgarità.`;
}

export interface LexiconEntry {
  readonly term: string;
  readonly meaning: string;
}

/**
 * Espressioni che la persona usa spesso: Ernie le capisce e le riusa liberamente quando calzano (scelta
 * dell'utente). Mai parolacce: le filtra già l'apprendimento, la regola resta anche qui.
 */
export function lexiconNote(name: string, entries: readonly LexiconEntry[]): string {
  if (!entries.length) return '';
  const list = entries
    .slice(0, 20)
    .map((e) => (e.meaning ? `«${e.term}» (${e.meaning})` : `«${e.term}»`))
    .join(', ');
  return `Parole ${name ? `di ${name}` : "dell'utente"}: espressioni che usa spesso, imparate dalle conversazioni: ${list}. Capiscile quando le usa e riusale liberamente quando calzano, con naturalezza e nel loro significato; restano compatibili con lo stile scelto. Non usare mai parolacce o volgarità, anche quando le usa chi ti scrive.`;
}
