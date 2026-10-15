/**
 * Luoghi dal second brain (richiesta dell'utente, 15 ott 2026): «fargli riconoscere anche i luoghi che sono nominati
 * in second brain». Le note di tipo «luogo» (cartella Luoghi) hanno nel frontmatter `luogo` (nome o indirizzo) e
 * `coordinate`; qui si ricava un luogo della scheda da una nota, senza modello.
 */

export interface BrainPlaceNote {
  readonly path: string;
  readonly title: string;
  readonly place: string | null;
  readonly coords: readonly [number, number] | null;
  readonly excerpt: string;
  readonly passage?: string;
}

export interface BrainPlace {
  readonly title: string;
  readonly address?: string;
  readonly lat?: number;
  readonly lng?: number;
}

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const STREET =
  /\b(?:via|viale|v\.le|piazza|p\.za|piazzale|corso|c\.so|strada|vicolo|largo|località|loc\.|contrada|frazione|borgo|lungomare|lungotevere)\s+[\p{L}'. ]{2,40}?(?:,?\s*\d+[a-z]?(?:\/[a-z0-9]+)?)?(?:,\s*(?:\d{5}\s+)?[\p{L}' ]{2,30})?(?=[.;\n)]|$|,\s*(?:tel|telefono|orari|aperto)\b)/iu;

/** Primo indirizzo che compare nel testo («via Roma 3, Treviso»), se c'è. */
export function addressIn(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const m = STREET.exec(text);
  return m
    ? m[0]
        .replace(/\s+/g, ' ')
        .replace(/[,\s]+$/u, '')
        .trim()
    : undefined;
}

/** Luogo da una nota: indirizzo dal frontmatter (se sembra un indirizzo) o dal testo, coordinate se ci sono. */
export function placeFromNote(n: BrainPlaceNote): BrainPlace | null {
  const address =
    addressIn(n.place) ?? addressIn(n.passage) ?? addressIn(n.excerpt) ?? n.place ?? undefined;
  const coords = n.coords;
  if (!address && !coords) return null;
  return {
    title: n.title,
    ...(address ? { address: address.slice(0, 160) } : {}),
    ...(coords ? { lat: coords[0], lng: coords[1] } : {}),
  };
}

/**
 * Nota che corrisponde al luogo detto («dentista» → «Studio dentistico Rossi»): il titolo contiene l'etichetta (o
 * viceversa), oppure il passaggio trovato la nomina. Solo note con un indirizzo o coordinate.
 */
export function pickBrainPlace(hits: readonly BrainPlaceNote[], label: string): BrainPlace | null {
  const want = fold(label);
  if (!want) return null;
  const stem = want.length > 5 ? want.slice(0, -2) : want; // «dentista» ~ «dentistico»
  const matches = (n: BrainPlaceNote) => {
    const t = fold(n.title);
    return t.includes(stem) || want.includes(t) || fold(n.passage ?? '').includes(want);
  };
  for (const n of hits) {
    if (!matches(n)) continue;
    const p = placeFromNote(n);
    if (p) return p;
  }
  return null;
}
