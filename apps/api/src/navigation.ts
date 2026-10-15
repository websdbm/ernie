import {
  directionsBlock,
  googleMapsDirectionsUrl,
  type NavigateStore,
  type PlaceCandidate,
  type SavedPlace,
  type TravelMode,
} from '@ernie/skills';
import { defineTool } from '@ernie/tools';
import { z } from 'zod';

/**
 * «Portami lì» lato server (richiesta dell'utente, 15 ott 2026): ricerca dei posti per disambiguare la destinazione
 * e strumenti per il modello. La ricerca usa Google Places (Text Search) se c'è GOOGLE_MAPS_API_KEY, altrimenti
 * OpenStreetMap (Nominatim, gratuito: al massimo una richiesta al secondo e un User-Agent che identifica l'app).
 * Il link finale è sempre di Google Maps e non richiede chiavi.
 */
export type PlaceSearch = (
  query: string,
  near?: { lat: number; lng: number },
) => Promise<readonly PlaceCandidate[]>;

export interface PlaceSearchOptions {
  readonly googleKey?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
  readonly logger?: { warn(obj: unknown, msg: string): void };
  /** Pausa minima fra due richieste a Nominatim (policy d'uso: una al secondo). */
  readonly nominatimIntervalMs?: number;
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

interface NominatimHit {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
}

/** «Via Roma 3, Padova» dai dettagli di Nominatim (il display_name è lungo e disordinato). */
export function nominatimAddress(h: NominatimHit): string {
  const a = h.address ?? {};
  const street = a.road ?? a.pedestrian ?? a.square ?? a.footway ?? a.path;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.county;
  const line = [street ? `${street}${a.house_number ? ` ${a.house_number}` : ''}` : null, city]
    .filter(Boolean)
    .join(', ');
  return line || (h.display_name ?? '').split(',').slice(0, 3).join(',').trim();
}

export function createPlaceSearch(opts: PlaceSearchOptions = {}): PlaceSearch {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const ua = opts.userAgent ?? 'Ernie-assistente/0.1 (+https://github.com/websdbm/ernie)';
  const interval = opts.nominatimIntervalMs ?? 1_100;
  const cache = new Map<string, { at: number; value: readonly PlaceCandidate[] }>();
  let nextSlot = 0;

  const google = async (query: string, near?: { lat: number; lng: number }) => {
    const res = await doFetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': opts.googleKey as string,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'it',
        regionCode: 'IT',
        maxResultCount: 5,
        ...(near
          ? {
              locationBias: {
                circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30_000 },
              },
            }
          : {}),
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`Google Places ${res.status}`);
    const json = (await res.json()) as { places?: GooglePlace[] };
    return (json.places ?? []).flatMap((p): PlaceCandidate[] => {
      const lat = p.location?.latitude;
      const lng = p.location?.longitude;
      if (lat === undefined || lng === undefined) return [];
      return [
        {
          name: p.displayName?.text ?? p.formattedAddress ?? query,
          address: (p.formattedAddress ?? '').replace(/,\s*Italia$/u, ''),
          lat,
          lng,
          ...(p.id ? { placeId: p.id } : {}),
        },
      ];
    });
  };

  const nominatim = async (query: string, near?: { lat: number; lng: number }) => {
    // Una richiesta al secondo, in fila.
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + interval;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '5',
      addressdetails: '1',
      'accept-language': 'it',
    });
    if (near) {
      const d = 0.4;
      params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
      params.set('bounded', '0');
    }
    const res = await doFetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { 'User-Agent': ua, Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const hits = (await res.json()) as NominatimHit[];
    return hits.flatMap((h): PlaceCandidate[] => {
      const lat = Number(h.lat);
      const lng = Number(h.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const address = nominatimAddress(h);
      return [{ name: h.name || address || query, address, lat, lng }];
    });
  };

  return async (query, near) => {
    const q = query.trim().slice(0, 200);
    if (!q) return [];
    const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3_600_000) return hit.value;
    try {
      const raw = opts.googleKey ? await google(q, near) : await nominatim(q, near);
      // Stesso posto due volte (stesso nome a pochi metri): uno solo.
      const value = raw.filter(
        (c, i) =>
          raw.findIndex(
            (o) =>
              o.name === c.name &&
              Math.abs(o.lat - c.lat) < 0.0005 &&
              Math.abs(o.lng - c.lng) < 0.0005,
          ) === i,
      );
      if (cache.size > 300) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      opts.logger?.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          provider: opts.googleKey ? 'google' : 'osm',
        },
        'ricerca del posto non riuscita',
      );
      return [];
    }
  };
}

/** Archivio della skill: luoghi della scheda (e del second brain) più la ricerca. */
export function createNavigateStore(deps: {
  findPlace: (userId: string, label: string) => Promise<SavedPlace | null>;
  search: PlaceSearch;
}): NavigateStore {
  return { findPlace: deps.findPlace, search: deps.search };
}

const Mode = z.enum(['driving', 'walking', 'bicycling', 'transit']);
const Candidate = z.object({
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  placeId: z.string().optional(),
});

/** Strumenti del modello: cerca un posto (per disambiguare) e prepara il link con il percorso. */
interface LinkTarget {
  label: string;
  address?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
}

export function createNavigationTools(store: NavigateStore) {
  // Ultimi link preparati: la scheda (present) li ritrova dall'URL.
  const lastLinks = new Map<string, LinkTarget & { mode: TravelMode }>();
  const remember = (url: string, v: LinkTarget & { mode: TravelMode }) => {
    lastLinks.set(url, v);
    if (lastLinks.size > 200) lastLinks.delete(lastLinks.keys().next().value as string);
  };
  return [
    defineTool({
      id: 'place_lookup',
      version: '1',
      category: 'places',
      description:
        "Cerca un posto o un indirizzo (Google Places o OpenStreetMap), vicino alla posizione dell'utente se disponibile: restituisce fino a 5 candidati con nome, indirizzo e coordinate. Usalo per capire quale posto intende l'utente prima di directions_link; se i candidati sono più di uno e non è chiaro, chiedi con present_choices.",
      risk: { readsPrivate: false, ingestsUntrusted: true, externalEffect: false, write: false },
      timeoutMs: 8_000,
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .max(200)
          .describe('Nome del posto o indirizzo, con la città se la conosci'),
        nearMe: z
          .boolean()
          .optional()
          .describe(
            'Cerca vicino alla posizione attuale (predefinito: sì, se il telefono la manda)',
          ),
      }),
      outputSchema: z.object({ candidates: z.array(Candidate) }),
      execute: async (input, ctx) => {
        const loc = ctx.device?.location;
        const near =
          input.nearMe !== false && loc ? { lat: loc.latitude, lng: loc.longitude } : undefined;
        const found = await store.search(input.query, near);
        return { candidates: found.slice(0, 5).map((c) => ({ ...c })) };
      },
      untrustedSource: () => 'place_search',
    }),
    defineTool({
      id: 'directions_link',
      version: '1',
      category: 'places',
      description:
        "Prepara il link di Google Maps con il percorso dalla posizione attuale e lo mostra come scheda «Portami lì». `destination` è un luogo salvato dell'utente («casa», «lavoro», «dentista»), un indirizzo completo o il nome di un posto; se hai già le coordinate (da place_lookup) passale con lat/lng e placeId. `mode`: driving (predefinito), walking, bicycling, transit.",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 6_000,
      inputSchema: z.object({
        destination: z.string().min(1).max(200),
        address: z.string().max(200).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        placeId: z.string().max(200).optional(),
        mode: Mode.optional(),
      }),
      outputSchema: z.object({
        url: z.string(),
        label: z.string(),
        address: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const mode = input.mode ?? 'driving';
        let target: {
          label: string;
          address?: string;
          lat?: number;
          lng?: number;
          placeId?: string;
        } = {
          label: input.destination,
          ...(input.address ? { address: input.address } : {}),
          ...(input.lat !== undefined && input.lng !== undefined
            ? { lat: input.lat, lng: input.lng }
            : {}),
          ...(input.placeId ? { placeId: input.placeId } : {}),
        };
        if (input.lat === undefined) {
          const saved = await store
            .findPlace(
              ctx.userId,
              input.destination.toLowerCase().replace(/^(?:il|lo|la|l')\s*/u, ''),
            )
            .catch(() => null);
          if (saved && (saved.address || saved.lat !== undefined))
            target = {
              label: saved.label,
              ...(saved.address ? { address: saved.address } : {}),
              ...(saved.lat !== undefined && saved.lng !== undefined
                ? { lat: saved.lat, lng: saved.lng }
                : {}),
            };
        }
        const url = googleMapsDirectionsUrl(
          {
            query: target.address ?? target.label,
            ...(target.lat !== undefined && target.lng !== undefined
              ? { lat: target.lat, lng: target.lng }
              : {}),
            ...(target.placeId ? { placeId: target.placeId } : {}),
          },
          mode,
        );
        remember(url, { ...target, mode });
        return { url, label: target.label, ...(target.address ? { address: target.address } : {}) };
      },
      present: (_input, out) => {
        const v = lastLinks.get(out.url);
        return v ? directionsBlock(v) : null;
      },
    }),
  ];
}
