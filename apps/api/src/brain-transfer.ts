/**
 * Travaso dalla memoria al second brain (fase B2, decisione dell'utente: «lo propone Ernie»). Senza modello:
 * si contano i ricordi che nominano la stessa persona o cosa; se sono almeno `minFacts` e nel second brain non
 * c'è una pagina con quel titolo, Ernie propone in una riga di farne una pagina. Al massimo una proposta per
 * conversazione e una volta ogni 30 giorni per argomento.
 */

export interface TransferCandidate {
  readonly entity: string;
  readonly facts: readonly string[];
}

/** Parole maiuscole che non sono nomi propri anche se capitano a metà frase. */
const STOP = new Set([
  'Ernie',
  'Impostazioni',
  'Lunedì',
  'Martedì',
  'Mercoledì',
  'Giovedì',
  'Venerdì',
  'Sabato',
  'Domenica',
  'Gennaio',
  'Febbraio',
  'Marzo',
  'Aprile',
  'Maggio',
  'Giugno',
  'Luglio',
  'Agosto',
  'Settembre',
  'Ottobre',
  'Novembre',
  'Dicembre',
  'Italia',
]);

/**
 * Nomi propri in un ricordo: parole con l'iniziale maiuscola che non aprono la frase (i ricordi sono scritti
 * in terza persona, «Ha un figlio di nome Giorgio»), più i nomi noti (familiari della scheda).
 */
export function entitiesIn(fact: string, known: readonly string[] = []): string[] {
  const out = new Set<string>();
  const lower = fact.toLowerCase();
  for (const k of known) if (k.length >= 3 && lower.includes(k.toLowerCase())) out.add(k);
  const words = fact.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1] ?? '';
    if (/[.!?:]$/.test(prev)) continue;
    const w = (words[i] ?? '').replace(/^[«"'(]+|[»"'),.;:!?]+$/g, '');
    if (/^\p{Lu}[\p{Ll}’']{2,}$/u.test(w) && !STOP.has(w)) out.add(w);
  }
  return [...out];
}

export function transferCandidate(
  facts: readonly string[],
  existingTitles: readonly string[],
  known: readonly string[] = [],
  opts: { minFacts?: number; skip?: ReadonlySet<string> } = {},
): TransferCandidate | null {
  const min = opts.minFacts ?? 4;
  const has = new Set(existingTitles.map((t) => t.toLowerCase()));
  const byEntity = new Map<string, string[]>();
  for (const f of facts)
    for (const e of entitiesIn(f, known)) byEntity.set(e, [...(byEntity.get(e) ?? []), f]);
  const ranked = [...byEntity.entries()]
    .filter(
      ([e, fs]) =>
        fs.length >= min && !has.has(e.toLowerCase()) && !opts.skip?.has(e.toLowerCase()),
    )
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const top = ranked[0];
  return top ? { entity: top[0], facts: top[1].slice(0, 12) } : null;
}

/** Blocco per il contesto del turno: la proposta, in una riga, da fare solo se c'è spazio nella risposta. */
export function formatTransferProposal(c: TransferCandidate): string {
  return [
    `Travaso proposto: tra i tuoi ricordi ce ne sono ${c.facts.length} su «${c.entity}» e nel second brain non c'è una pagina. Se la conversazione lo permette, proponi in una riga di fargliene una (es. «Ho ${c.facts.length} cose su ${c.entity}: ne faccio una pagina nel second brain?»). Se accetta, scrivila con brain_write (type persona, luogo, progetto o argomento) mettendo insieme questi ricordi; se dice di no, lascia stare.`,
    ...c.facts.map((f) => `- ${f}`),
  ].join('\n');
}
