import { describe, expect, it } from 'vitest';
import {
  createNavigateSkill,
  googleMapsDirectionsUrl,
  looksLikeAddress,
  type NavigateStore,
  navigateFollowUp,
  type PlaceCandidate,
  parseNavigateCommand,
} from './navigate.js';

const ctx = {
  userId: 'u',
  sessionId: null,
  requestId: 'r',
  device: { location: { latitude: 45.4, longitude: 11.87 } },
};

function store(over: Partial<NavigateStore> = {}) {
  const searched: Array<{ query: string; near?: { lat: number; lng: number } }> = [];
  const s: NavigateStore = {
    findPlace: async (_u, label) =>
      label === 'casa'
        ? { label: 'casa', address: 'via Barozzi 4, Padova', lat: 45.41, lng: 11.88 }
        : label === 'dentista'
          ? { label: 'dentista', address: 'corso Italia 10, Roma', note: 'Studio dentistico Rossi' }
          : null,
    search: async (query, near) => {
      searched.push({ query, ...(near ? { near } : {}) });
      return [];
    },
    ...over,
  };
  return { s, searched };
}

const pizzerie: PlaceCandidate[] = [
  {
    name: 'Pizzeria Da Mario',
    address: 'Via Roma 3, Padova, Veneto, Italia',
    lat: 45.4,
    lng: 11.87,
    placeId: 'p1',
  },
  {
    name: 'Pizzeria Da Mario',
    address: 'Via Garibaldi 8, Abano Terme, Veneto, Italia',
    lat: 45.36,
    lng: 11.79,
  },
];

describe('skill «Portami lì»', () => {
  it('riconosce le richieste di indicazioni, con il mezzo; «lì» lo lascia al modello', () => {
    expect(parseNavigateCommand('Portami a casa')).toEqual({ op: 'go', dest: 'casa' });
    expect(parseNavigateCommand('portami in via Roma 3, Treviso')).toEqual({
      op: 'go',
      dest: 'via Roma 3, Treviso',
    });
    expect(parseNavigateCommand('come arrivo dal dentista?')).toEqual({
      op: 'go',
      dest: 'dentista',
    });
    expect(parseNavigateCommand('indicazioni per la stazione di Padova a piedi')).toEqual({
      op: 'go',
      dest: 'la stazione di Padova',
      mode: 'walking',
    });
    expect(parseNavigateCommand('portami al lavoro con i mezzi')).toEqual({
      op: 'go',
      dest: 'lavoro',
      mode: 'transit',
    });
    expect(parseNavigateCommand('[voce] Ernie, mostrami la strada per il Duomo di Milano')).toEqual(
      {
        op: 'go',
        dest: 'il Duomo di Milano',
      },
    );
    expect(parseNavigateCommand('portami a casa di Giorgio')).toEqual({
      op: 'go',
      dest: 'casa di Giorgio',
    });
    expect(parseNavigateCommand('portami lì')).toBeNull();
    expect(parseNavigateCommand('ricordami di andare a casa')).toBeNull();
    expect(parseNavigateCommand('che tempo fa a Padova?')).toBeNull();
  });

  it('link di Google Maps: coordinate se ci sono, altrimenti indirizzo; mezzo e identificativo del posto', () => {
    expect(googleMapsDirectionsUrl({ query: 'via Roma 3, Treviso' })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=via+Roma+3%2C+Treviso&travelmode=driving',
    );
    expect(googleMapsDirectionsUrl({ lat: 45.41, lng: 11.88, placeId: 'abc' }, 'walking')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=45.410000%2C11.880000&travelmode=walking&destination_place_id=abc',
    );
    expect(looksLikeAddress('via Roma 3, Treviso')).toBe(true);
    expect(looksLikeAddress('piazza Duomo, Milano')).toBe(true);
    expect(looksLikeAddress('pizzeria Da Mario')).toBe(false);
  });

  it('luogo della scheda (o del second brain) → link diretto, senza ricerca', async () => {
    const { s, searched } = store();
    const skill = createNavigateSkill(s);
    const r = await skill.run({ op: 'go', dest: 'casa' }, ctx);
    expect(r.text).toBe(
      '🧭 Ecco la strada per casa (via Barozzi 4, Padova): tocca «Apri in Google Maps».',
    );
    expect(r.blocks?.[0]).toMatchObject({
      kind: 'directions',
      label: 'casa',
      lat: 45.41,
      mode: 'driving',
    });
    const d = await skill.run({ op: 'go', dest: 'il dentista', mode: 'walking' }, ctx);
    expect(d.text).toContain('a piedi per dentista');
    expect(d.text).toContain('nota «Studio dentistico Rossi»');
    expect(searched).toHaveLength(0);
  });

  it('indirizzo: link con l’indirizzo; posto unico: link; più posti: pulsanti e scelta esatta; nessuno: chiede', async () => {
    const one = store({ search: async () => [pizzerie[0] as PlaceCandidate] });
    const skill = createNavigateSkill(one.s);
    const addr = await skill.run({ op: 'go', dest: 'via Roma 3, Treviso' }, ctx);
    expect(addr.blocks?.[0]).toMatchObject({
      kind: 'directions',
      label: 'via Roma 3, Treviso',
      lat: 45.4,
    });
    const single = await skill.run({ op: 'go', dest: 'pizzeria Da Mario' }, ctx);
    expect(single.blocks?.[0]).toMatchObject({
      label: 'Pizzeria Da Mario',
      address: 'Via Roma 3, Padova, Veneto, Italia',
    });
    expect((single.blocks?.[0] as unknown as { url: string }).url).toContain(
      'destination_place_id=p1',
    );

    const many = store({ search: async () => pizzerie });
    const m = await createNavigateSkill(many.s).run({ op: 'go', dest: 'pizzeria Da Mario' }, ctx);
    expect(m.blocks?.[0]).toMatchObject({
      kind: 'choices',
      options: [
        { label: 'Pizzeria Da Mario, Via Roma 3, Padova' },
        { label: 'Pizzeria Da Mario, Via Garibaldi 8, Abano Terme' },
        { label: 'Nessuno di questi' },
      ],
    });
    const pick = navigateFollowUp(m.awaiting, 'Pizzeria Da Mario, Via Garibaldi 8, Abano Terme');
    expect(pick).toMatchObject({ op: 'pick', place: { lat: 45.36, lng: 11.79 } });
    expect(navigateFollowUp(m.awaiting, 'il secondo')).toMatchObject({
      op: 'pick',
      place: { lat: 45.36 },
    });
    expect(navigateFollowUp(m.awaiting, 'Nessuno di questi')).toEqual({ op: 'none' });
    expect(navigateFollowUp(m.awaiting, 'che tempo fa?')).toBeNull();
    const done = await createNavigateSkill(many.s).run(pick, ctx);
    expect(done.blocks?.[0]).toMatchObject({ kind: 'directions', lat: 45.36 });

    const none = await createNavigateSkill(store().s).run(
      { op: 'go', dest: 'posto inesistente' },
      ctx,
    );
    expect(none.text).toContain('Non trovo «posto inesistente»');
    expect(many.searched).toEqual([]);
  });
});
