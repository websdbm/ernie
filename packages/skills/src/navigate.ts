import type { ContentBlock } from '@ernie/protocol';
import type { DeterministicSkill, SkillReply } from './types.js';

/**
 * Skill «Portami lì» (richiesta dell'utente, 15 ott 2026): «portami a casa», «portami in via Roma 3, Treviso»,
 * «come arrivo dal dentista?», «indicazioni per la pizzeria Da Mario a piedi». La destinazione è un luogo della
 * scheda (o del second brain), un indirizzo detto per intero o un posto da cercare; la risposta è il link a Google
 * Maps con il percorso dalla posizione attuale. Più posti con lo stesso nome: si sceglie con un tocco. Riferimenti al
 * discorso («portami lì») e frasi complesse le gestisce il modello con gli strumenti place_lookup e directions_link.
 */
export type TravelMode = 'driving' | 'walking' | 'bicycling' | 'transit';

export type NavigatePlan =
  | { readonly op: 'go'; readonly dest: string; readonly mode?: TravelMode }
  /** Scelta fra i posti trovati (tocco su un'opzione): coordinate e identificativo esatti. */
  | { readonly op: 'pick'; readonly place: PlaceCandidate; readonly mode?: TravelMode }
  | { readonly op: 'none' };

/** Posti proposti con i pulsanti, in attesa della scelta (`awaiting` della skill). */
interface NavigateAwaiting {
  readonly kind: 'navigate';
  readonly mode?: TravelMode;
  readonly options: readonly (PlaceCandidate & { readonly label: string })[];
}

const NONE_LABEL = 'Nessuno di questi';

/** Risposta ai pulsanti dei posti trovati: l'opzione toccata (o detta: «il secondo», il nome), oppure nessuna. */
export function navigateFollowUp(awaiting: unknown, input: string): NavigatePlan | null {
  const a = awaiting as Partial<NavigateAwaiting> | null;
  if (a?.kind !== 'navigate' || !Array.isArray(a.options)) return null;
  const t = input
    .replace(/^\[voce\]\s*/u, '')
    .trim()
    .toLowerCase();
  if (t === NONE_LABEL.toLowerCase() || /^(?:nessuno|nessuna|no|niente|annulla)\b/u.test(t))
    return { op: 'none' };
  const ord = ['prim', 'second', 'terz', 'quart'].findIndex((w) =>
    new RegExp(`\\b(?:il|la|l')?\\s*${w}[oa]\\b`, 'u').test(t),
  );
  const chosen =
    a.options.find((o) => o.label.toLowerCase() === t) ??
    (ord >= 0 ? a.options[ord] : undefined) ??
    a.options.find((o) => t.includes(o.name.toLowerCase()));
  if (!chosen) return null;
  const { label: _label, ...place } = chosen;
  return { op: 'pick', place, ...(a.mode ? { mode: a.mode } : {}) };
}

export interface PlaceCandidate {
  readonly name: string;
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
  /** Identificativo di Google Places, se la ricerca è di Google: rende il link più preciso. */
  readonly placeId?: string;
}

export interface SavedPlace {
  readonly label: string;
  readonly address?: string;
  readonly lat?: number;
  readonly lng?: number;
  /** Titolo della nota del second brain da cui viene, se non era nella scheda. */
  readonly note?: string;
}

export interface NavigateStore {
  /** Luogo della scheda per nome («casa», «lavoro», «dentista»), anche dal second brain. */
  findPlace(userId: string, label: string): Promise<SavedPlace | null>;
  /** Ricerca di un posto o di un indirizzo (Google Places se configurato, altrimenti OpenStreetMap). */
  search(query: string, near?: { lat: number; lng: number }): Promise<readonly PlaceCandidate[]>;
}

const MODE_LABEL: Record<TravelMode, string> = {
  driving: 'in auto',
  walking: 'a piedi',
  bicycling: 'in bici',
  transit: 'con i mezzi',
};

/** Link di Google Maps con il percorso dalla posizione attuale (non serve una chiave). */
export function googleMapsDirectionsUrl(
  dest: { query?: string; lat?: number; lng?: number; placeId?: string },
  mode: TravelMode = 'driving',
): string {
  const where =
    dest.lat !== undefined && dest.lng !== undefined
      ? `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`
      : (dest.query ?? '');
  const params = new URLSearchParams({ api: '1', destination: where, travelmode: mode });
  if (dest.placeId) params.set('destination_place_id', dest.placeId);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function directionsBlock(input: {
  label: string;
  address?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  placeId?: string | undefined;
  mode?: TravelMode | undefined;
}): ContentBlock {
  const mode = input.mode ?? 'driving';
  return {
    kind: 'directions',
    label: input.label.slice(0, 120),
    ...(input.address ? { address: input.address.slice(0, 200) } : {}),
    ...(input.lat !== undefined && input.lng !== undefined
      ? { lat: input.lat, lng: input.lng }
      : {}),
    mode,
    url: googleMapsDirectionsUrl(
      {
        query: input.address ?? input.label,
        ...(input.lat !== undefined && input.lng !== undefined
          ? { lat: input.lat, lng: input.lng }
          : {}),
        ...(input.placeId ? { placeId: input.placeId } : {}),
      },
      mode,
    ),
  };
}

const MODES: ReadonlyArray<[RegExp, TravelMode]> = [
  [/(?:^|[\s,])(?:a\s+piedi|camminando)(?=[\s,.!?]|$)/iu, 'walking'],
  [
    /(?:^|[\s,])(?:in\s+bici(?:cletta)?|con\s+la\s+bici(?:cletta)?|pedalando)(?=[\s,.!?]|$)/iu,
    'bicycling',
  ],
  [
    /(?:^|[\s,])(?:con\s+i\s+mezzi(?:\s+pubblici)?|coi\s+mezzi(?:\s+pubblici)?|in\s+(?:autobus|bus|tram|treno|metro(?:politana)?)|con\s+(?:l'autobus|il\s+bus|il\s+tram|il\s+treno|la\s+metro))(?=[\s,.!?]|$)/iu,
    'transit',
  ],
  [
    /(?:^|[\s,])(?:in\s+(?:macchina|auto(?:mobile)?)|con\s+la\s+macchina|guidando)(?=[\s,.!?]|$)/iu,
    'driving',
  ],
];

const PREP =
  "(?:fino\\s+(?:a|al|alla|allo|all')|a|al|allo|alla|ai|agli|alle|all'|in|nel|nello|nella|nei|negli|nelle|nell'|da|dal|dallo|dalla|dai|dagli|dalle|dall'|per|verso|presso)";

/** Riferimenti al discorso: li risolve il modello, che conosce gli ultimi scambi. */
const CONTEXTUAL =
  /^(?:lì|li|là|la|qui|qua|ci|quel\s+posto|quello|quella|lo\s+stesso\s+posto|dove\s+(?:ti\s+)?ho\s+detto)$/iu;

/** Riconosce una richiesta di indicazioni; null se la frase non è di questo tipo. */
export function parseNavigateCommand(input: string): NavigatePlan | null {
  let t = input
    .replace(/[‘’´`]/gu, "'")
    .trim()
    .replace(/^\[voce\]\s*/u, '')
    .replace(/^(?:ernie|ehi\s+ernie|senti)[,\s]+/iu, '')
    .replace(/[?!.]+$/u, '')
    .trim();
  let mode: TravelMode | undefined;
  for (const [re, m] of MODES)
    if (re.test(t)) {
      mode = m;
      t = t
        .replace(re, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+,/g, ',')
        .trim()
        .replace(/,$/u, '')
        .trim();
      break;
    }
  const patterns = [
    new RegExp(
      `^(?:mi\\s+)?(?:portami|portaci|accompagnami|accompagnaci|guidami|navigami)(?:\\s+${PREP})?\\s+(?<dest>.+)$`,
      'iu',
    ),
    new RegExp(
      `^(?:avvia\\s+(?:la\\s+)?navigazione|naviga|navigazione|navigatore|indicazioni(?:\\s+stradali)?|percorso|(?:fammi\\s+vedere|mostrami|dammi|apri|trovami)\\s+(?:il\\s+percorso|la\\s+strada|le\\s+indicazioni(?:\\s+stradali)?|il\\s+navigatore|la\\s+mappa))\\s+${PREP}\\s+(?<dest>.+)$`,
      'iu',
    ),
    new RegExp(
      `^come\\s+(?:ci\\s+)?(?:arrivo|si\\s+arriva|vado|posso\\s+andare|faccio\\s+ad?\\s+(?:arrivare|andare))\\s+${PREP}\\s+(?<dest>.+)$`,
      'iu',
    ),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    const dest = m?.groups?.dest
      ?.replace(/^[«"“]+|[»"”]+$/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!dest) continue;
    if (CONTEXTUAL.test(dest) || dest.length > 140) return null;
    return { op: 'go', dest, ...(mode ? { mode } : {}) };
  }
  return null;
}

/** Indirizzo detto per intero («via Roma 3, Treviso», «piazza Duomo, Milano»): Google Maps lo trova da solo. */
export function looksLikeAddress(text: string): boolean {
  return (
    /\b(?:via|viale|v\.le|piazza|p\.za|piazzale|corso|c\.so|strada|vicolo|largo|lungomare|località|loc\.|contrada|borgo)\s+\S+/iu.test(
      text,
    ) &&
    (/\d/u.test(text) || /,\s*\p{L}{3,}/u.test(text))
  );
}

/** «a casa» → «casa», «dal dentista» → «dentista»: il nome con cui il luogo può essere nella scheda. */
export function placeLabelOf(dest: string): string {
  return dest
    .toLowerCase()
    .replace(/^(?:il|lo|la|i|gli|le|l')\s*/u, '')
    .replace(/^(?:mio|mia|miei|mie)\s+/u, '')
    .trim();
}

const shortAddress = (a: string) => a.split(',').slice(0, 2).join(',').trim();

function reply(
  target: { label: string; address?: string; lat?: number; lng?: number; placeId?: string },
  mode: TravelMode | undefined,
  extra = '',
): SkillReply {
  const how = mode && mode !== 'driving' ? ` ${MODE_LABEL[mode]}` : '';
  const where =
    target.address && target.address !== target.label ? ` (${shortAddress(target.address)})` : '';
  return {
    text: `🧭 Ecco la strada${how} per ${target.label}${where}: tocca «Apri in Google Maps».${extra}`,
    actions: [`directions:${target.label}`],
    blocks: [directionsBlock({ ...target, mode })],
  };
}

export function createNavigateSkill(store: NavigateStore | null): DeterministicSkill {
  return {
    id: 'portami',
    kind: 'deterministic',
    category: 'places',
    description:
      'Indicazioni stradali con Google Maps: «portami a casa», «portami in via Roma 3, Treviso», «come arrivo dal dentista?», «indicazioni per la pizzeria Da Mario a piedi». Destinazione dai luoghi salvati, da un indirizzo o cercando il posto; percorso dalla posizione attuale.',
    examples: [
      'portami a casa',
      'portami in via Roma 3, Treviso',
      'come arrivo dal dentista?',
      'indicazioni per la stazione di Padova a piedi',
    ],
    match: (text) => parseNavigateCommand(text),
    followUp: (awaiting, text) => navigateFollowUp(awaiting, text),
    describe: (plan) => {
      const p = plan as NavigatePlan;
      return p.op === 'go'
        ? `indicazioni stradali per arrivare a «${p.dest}»${p.mode ? ` ${MODE_LABEL[p.mode]}` : ''}`
        : null;
    },
    run: async (plan, ctx): Promise<SkillReply> => {
      const p = plan as NavigatePlan;
      if (p.op === 'none')
        return {
          text: 'Va bene. Dimmi l’indirizzo (via, numero e città) o un nome più preciso e ti preparo la strada.',
          actions: [],
        };
      if (p.op === 'pick')
        return reply(
          {
            label: p.place.name,
            address: p.place.address,
            lat: p.place.lat,
            lng: p.place.lng,
            ...(p.place.placeId ? { placeId: p.place.placeId } : {}),
          },
          p.mode,
        );
      if (!store)
        return {
          text: 'Le indicazioni stradali non sono disponibili in questo contesto.',
          actions: [],
        };
      const loc = ctx.device?.location;
      const near = loc ? { lat: loc.latitude, lng: loc.longitude } : undefined;
      // 1) Un luogo salvato (scheda o second brain).
      const label = placeLabelOf(p.dest);
      const saved =
        label.length >= 2 ? await store.findPlace(ctx.userId, label).catch(() => null) : null;
      if (saved && (saved.address || (saved.lat !== undefined && saved.lng !== undefined)))
        return reply(
          {
            label: saved.label,
            ...(saved.address ? { address: saved.address } : {}),
            ...(saved.lat !== undefined && saved.lng !== undefined
              ? { lat: saved.lat, lng: saved.lng }
              : {}),
          },
          p.mode,
          saved.note ? ` L’ho preso dalla tua nota «${saved.note}».` : '',
        );
      // 2) Un indirizzo detto per intero: basta quello (la ricerca serve solo all'anteprima della mappa).
      if (looksLikeAddress(p.dest)) {
        const hit = (await store.search(p.dest, near).catch(() => []))[0];
        return reply(
          {
            label: p.dest,
            address: p.dest,
            ...(hit ? { lat: hit.lat, lng: hit.lng } : {}),
          },
          p.mode,
        );
      }
      // 3) Un posto da cercare, vicino a dove sei se il telefono lo dice.
      const found = await store.search(p.dest, near).catch(() => []);
      if (!found.length)
        return {
          text: `Non trovo «${p.dest}». Dimmi l’indirizzo (via, numero e città) oppure salvalo tra i tuoi luoghi in Impostazioni › La tua scheda.`,
          actions: [],
        };
      const first = found[0] as PlaceCandidate;
      if (found.length === 1)
        return reply(
          {
            label: first.name,
            address: first.address,
            lat: first.lat,
            lng: first.lng,
            ...(first.placeId ? { placeId: first.placeId } : {}),
          },
          p.mode,
        );
      const how = p.mode && p.mode !== 'driving' ? ` ${MODE_LABEL[p.mode]}` : '';
      const options = found.slice(0, 4).map((c) => ({
        ...c,
        label: `${c.name}, ${shortAddress(c.address)}`.slice(0, 80),
      }));
      const awaiting: NavigateAwaiting = {
        kind: 'navigate',
        options,
        ...(p.mode ? { mode: p.mode } : {}),
      };
      return {
        text: `Ho trovato più posti per «${p.dest}»: quale intendi?`,
        actions: [],
        awaiting,
        blocks: [
          {
            kind: 'choices',
            question: `Dove vuoi andare${how}?`,
            options: [
              ...options.map((o, i) => ({ id: String(i + 1), label: o.label })),
              { id: String(options.length + 1), label: NONE_LABEL },
            ],
          },
        ],
      };
    },
  };
}
