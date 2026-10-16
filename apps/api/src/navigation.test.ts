import { describe, expect, it, vi } from 'vitest';
import {
  createNavigationTools,
  createPlaceSearch,
  metersBetween,
  nominatimAddress,
} from './navigation.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('«Portami lì»: ricerca dei posti', () => {
  it('OpenStreetMap senza chiave: indirizzo pulito, vicino al telefono, User-Agent, cache', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json([
        {
          lat: '45.4170',
          lon: '11.8800',
          name: 'Stazione di Padova',
          display_name:
            'Stazione di Padova, Piazzale della Stazione, Arcella, Padova, Veneto, 35131, Italia',
          address: { road: 'Piazzale della Stazione', city: 'Padova' },
        },
        { lat: 'x', lon: '1' },
      ]),
    );
    const search = createPlaceSearch({ fetch: fetch as never, nominatimIntervalMs: 0 });
    const r = await search('stazione di Padova', { lat: 45.4, lng: 11.87 });
    expect(r).toEqual([
      {
        name: 'Stazione di Padova',
        address: 'Piazzale della Stazione, Padova',
        lat: 45.417,
        lng: 11.88,
      },
    ]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('nominatim.openstreetmap.org/search?');
    expect(url).toContain('viewbox=');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^Ernie/);
    await search('stazione di Padova', { lat: 45.4, lng: 11.87 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Google Places con la chiave: posti con identificativo; errori → nessun risultato', async () => {
    const fetch = vi.fn(async () =>
      json({
        places: [
          {
            id: 'ChIJ1',
            displayName: { text: 'Pizzeria Da Mario' },
            formattedAddress: 'Via Roma, 3, 35122 Padova PD, Italia',
            location: { latitude: 45.4, longitude: 11.87 },
          },
        ],
      }),
    );
    const search = createPlaceSearch({ googleKey: 'k', fetch: fetch as never });
    expect(await search('pizzeria da mario')).toEqual([
      {
        name: 'Pizzeria Da Mario',
        address: 'Via Roma, 3, 35122 Padova PD',
        lat: 45.4,
        lng: 11.87,
        placeId: 'ChIJ1',
      },
    ]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('k');
    const broken = createPlaceSearch({
      googleKey: 'k',
      fetch: (async () => json({}, 403)) as never,
    });
    expect(await broken('x y')).toEqual([]);
  });

  it('vicino a chi chiede: prima entro ~50 km, poi ovunque; dal più vicino; posti a pochi metri uniti; senza articolo', async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      // La ricerca limitata non trova nulla: si allarga.
      if (String(url).includes('bounded=1')) return json([]);
      return json([
        {
          lat: '45.47',
          lon: '9.22',
          name: 'Via Padova',
          address: { road: 'Via Padova', city: 'Milano' },
        },
        {
          lat: '45.4179',
          lon: '11.8800',
          name: 'Padova',
          address: { road: 'Piazzale della Stazione', city: 'Padova' },
        },
        { lat: '45.4181', lon: '11.8803', name: 'Biglietteria', address: { city: 'Padova' } },
      ]);
    });
    const search = createPlaceSearch({ fetch: fetch as never, nominatimIntervalMs: 0 });
    const r = await search('la stazione di Padova', { lat: 45.4064, lng: 11.8768 });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('q=stazione+di+Padova');
    expect(urls[0]).toContain('bounded=1');
    expect(r.map((c) => c.name)).toEqual(['Padova', 'Via Padova']);
    expect(
      Math.round(metersBetween({ lat: 45.4064, lng: 11.8768 }, { lat: 45.4179, lng: 11.88 })),
    ).toBeGreaterThan(1000);
  });

  it('Google con un errore (API non attiva): si ripiega su OpenStreetMap', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('places.googleapis.com')
        ? json({ error: { code: 403 } }, 403)
        : json([{ lat: '45.41', lon: '11.88', name: 'Stazione', address: { city: 'Padova' } }]),
    );
    const search = createPlaceSearch({
      googleKey: 'k',
      fetch: fetch as never,
      nominatimIntervalMs: 0,
    });
    expect((await search('stazione di Padova')).map((c) => c.name)).toEqual(['Stazione']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('indirizzo da Nominatim anche senza strada', () => {
    expect(
      nominatimAddress({
        display_name: 'Ikea, Padova, Veneto, Italia',
        address: { town: 'Padova' },
      }),
    ).toBe('Padova');
    expect(nominatimAddress({ display_name: 'A, B, C, D' })).toBe('A, B, C');
  });
});

describe('«Portami lì»: strumenti del modello', () => {
  it('directions_link usa il luogo salvato; con coordinate le usa; la scheda è «directions»', async () => {
    const store = {
      findPlace: async (_u: string, label: string) =>
        label === 'casa'
          ? { label: 'casa', address: 'via Barozzi 4, Padova', lat: 45.41, lng: 11.88 }
          : null,
      search: async () => [],
    };
    const [, link] = createNavigationTools(store);
    const ctx = { userId: 'u', sessionId: null, requestId: 'r', scopes: [], run: {} as never };
    type Out = { url: string; label: string; address?: string };
    const out = (await link?.execute({ destination: 'Casa' }, ctx as never)) as Out;
    expect(out).toMatchObject({ label: 'casa', address: 'via Barozzi 4, Padova' });
    expect(out?.url).toContain('destination=45.410000%2C11.880000');
    expect(link?.present?.({ destination: 'Casa' }, out as never)).toMatchObject({
      kind: 'directions',
      label: 'casa',
    });
    const walk = (await link?.execute(
      {
        destination: 'Pizzeria Da Mario',
        lat: 45.4,
        lng: 11.87,
        placeId: 'ChIJ1',
        mode: 'walking',
      },
      ctx as never,
    )) as Out;
    expect(walk?.url).toContain('travelmode=walking');
    expect(walk?.url).toContain('destination_place_id=ChIJ1');
  });
});
