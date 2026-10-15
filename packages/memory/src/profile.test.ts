import { describe, expect, it } from 'vitest';
import {
  describeBirthDate,
  emptyProfile,
  findPlace,
  formatProfileNotices,
  mergeProfile,
  normalizeBirthDate,
  normalizePlaceLabel,
  placeHere,
  renamePlace,
  renderProfile,
  replaceProfileByUser,
  setPlaceCoordinates,
  upsertPlace,
} from './profile.js';

const at = new Date('2026-10-13T10:00:00Z');
const chat = { source: 'conversation' as const, at };

describe('scheda anagrafica: fusione', () => {
  it('riempie i campi dalla chat e ignora i segnaposto', () => {
    const { profile, changes } = mergeProfile(
      emptyProfile(),
      {
        fullName: 'Alessandro Grassi',
        preferredName: 'Ale',
        birthDate: '1975-05-03',
        gender: 'uomo',
        city: 'null',
        occupation: '  ',
        family: [{ name: 'Giorgio', relation: 'figlio', birthDate: '2013-02-10' }],
      },
      { ...chat, quote: 'mi chiamo Alessandro, chiamami Ale' },
    );
    expect(profile).toMatchObject({
      fullName: 'Alessandro Grassi',
      preferredName: 'Ale',
      birthDate: '1975-05-03',
      gender: 'uomo',
    });
    expect(profile.city).toBeUndefined();
    expect(profile.family).toMatchObject([
      { name: 'Giorgio', relation: 'figlio', birthDate: '2013-02-10' },
    ]);
    expect(profile.meta.preferredName).toMatchObject({
      source: 'conversation',
      quote: 'mi chiamo Alessandro, chiamami Ale',
    });
    expect(changes.map((c) => c.field)).toEqual([
      'fullName',
      'preferredName',
      'birthDate',
      'gender',
      'family',
    ]);
  });

  it('una correzione in chat sostituisce la chat, mai quello scritto nell’app', () => {
    const first = mergeProfile(
      emptyProfile(),
      { city: 'Mestre', preferredName: 'Ale' },
      chat,
    ).profile;
    const corrected = mergeProfile(first, { city: 'Padova' }, chat);
    expect(corrected.profile.city).toBe('Padova');
    expect(corrected.changes).toEqual([{ field: 'city', before: 'Mestre', after: 'Padova' }]);
    const edited = replaceProfileByUser(
      corrected.profile,
      { fields: { city: 'Venezia', preferredName: 'Ale' }, family: [] },
      at,
    ).profile;
    expect(edited.meta.city?.source).toBe('user');
    // Il nome non è cambiato: conserva la provenienza dalla chat.
    expect(edited.meta.preferredName?.source).toBe('conversation');
    const again = mergeProfile(edited, { city: 'Treviso', preferredName: 'Alessandro' }, chat);
    expect(again.profile.city).toBe('Venezia');
    expect(again.profile.preferredName).toBe('Alessandro');
    // Il contrasto con un dato scritto nell'app non cambia la scheda: diventa una domanda per l'utente.
    expect(again.conflicts).toEqual([
      { field: 'city', before: 'Venezia', after: 'Treviso', conflict: true },
    ]);
    const notice = formatProfileNotices([{ id: '9', at, changes: again.conflicts }]);
    expect(notice).toContain('Non ho cambiato la scheda');
    expect(notice).toContain("in chat ha detto «Treviso», ma nella scheda c'è «Venezia»");
  });

  it('famiglia: riconosce per nome senza accenti, completa, non duplica; senza nome per relazione', () => {
    let p = mergeProfile(
      emptyProfile(),
      { family: [{ name: 'Niccolò', relation: 'figlio' }, { relation: 'cane' }] },
      chat,
    ).profile;
    p = mergeProfile(
      p,
      {
        family: [
          { name: 'niccolo', relation: 'figlio', birthDate: '--06-21' },
          { relation: 'cane', notes: 'si chiama Briciola?' },
        ],
      },
      chat,
    ).profile;
    expect(p.family).toHaveLength(2);
    expect(p.family[0]).toMatchObject({ name: 'Niccolò', birthDate: '--06-21' });
    expect(p.family[1]).toMatchObject({ relation: 'cane', notes: 'si chiama Briciola?' });
    // La data parziale non sostituisce quella completa compatibile.
    p = mergeProfile(
      p,
      { family: [{ name: 'Niccolò', relation: 'figlio', birthDate: '2014-06-21' }] },
      chat,
    ).profile;
    const kept = mergeProfile(
      p,
      { family: [{ name: 'Niccolò', relation: 'figlio', birthDate: '--06-21' }] },
      chat,
    );
    expect(kept.changes).toEqual([]);
    expect(kept.profile.family[0]?.birthDate).toBe('2014-06-21');
  });

  it('dall’app si tolgono familiari e si cambia tutto, con revisione', () => {
    const p = mergeProfile(
      emptyProfile(),
      {
        family: [
          { name: 'Laura', relation: 'moglie' },
          { name: 'Giorgio', relation: 'figlio' },
        ],
      },
      chat,
    ).profile;
    const giorgio = p.family.find((m) => m.name === 'Giorgio');
    const { profile, changes } = replaceProfileByUser(
      p,
      {
        fields: {},
        family: [{ id: giorgio?.id, name: 'Giorgio', relation: 'figlio', birthDate: '2013-02-10' }],
      },
      at,
    );
    expect(profile.family).toHaveLength(1);
    expect(profile.family[0]?.meta.source).toBe('user');
    expect(changes.map((c) => [c.before, c.after])).toEqual([
      ['Giorgio (figlio)', 'Giorgio (figlio), nato il 10 febbraio 2013 (13 anni)'],
      ['Laura (moglie)', null],
    ]);
  });
});

describe('scheda anagrafica: date e testo', () => {
  it('date di nascita valide, parziali e scartate', () => {
    expect(normalizeBirthDate('1975-05-03', at)).toBe('1975-05-03');
    expect(normalizeBirthDate('--02-29', at)).toBe('--02-29');
    expect(normalizeBirthDate('1975-02-30', at)).toBeUndefined();
    expect(normalizeBirthDate('2027-01-01', at)).toBeUndefined();
    expect(normalizeBirthDate('50 anni', at)).toBeUndefined();
    expect(describeBirthDate('1975-10-14', at)).toBe('14 ottobre 1975 (50 anni)');
    expect(describeBirthDate('1975-10-13', at)).toBe('13 ottobre 1975 (51 anni)');
  });

  it('testo per il prompt con nome preferito, età e famiglia; vuoto se non c’è nulla', () => {
    expect(renderProfile(emptyProfile(), at)).toBe('');
    const p = mergeProfile(
      emptyProfile(),
      {
        fullName: 'Alessandro Grassi',
        preferredName: 'Ale',
        birthDate: '1975-05-03',
        city: 'Padova',
        family: [{ name: 'Giorgio', relation: 'figlio', birthDate: '2013-02-10' }],
      },
      chat,
    ).profile;
    const text = renderProfile(p, at);
    expect(text).toContain('prevalgono sulle memorie');
    expect(text).toContain('Nome: Alessandro Grassi; vuole essere chiamato «Ale»');
    expect(text).toContain('Nato/a il 3 maggio 1975 (51 anni)');
    expect(text).toContain('Famiglia: Giorgio (figlio), nato il 10 febbraio 2013 (13 anni)');
    const forUser = renderProfile(p, at, 'user');
    expect(forUser).toContain('- Nome: Alessandro Grassi (ti chiamo «Ale»)');
    expect(forUser).not.toContain('usa questo nome');
    expect(forUser).not.toContain('prevalgono');
    expect(
      formatProfileNotices([
        { id: '1', at, changes: [{ field: 'birthDate', before: null, after: '1975-05-03' }] },
      ]),
    ).toContain('data di nascita: 3 maggio 1975 (51 anni)');
  });
});

describe('scheda anagrafica: email', () => {
  it('email valida in minuscolo; sbagliata ignorata; dalla chat non sostituisce quella scritta nell’app', async () => {
    const { normalizeEmail } = await import('./profile.js');
    expect(normalizeEmail(' Ale@Example.COM ')).toBe('ale@example.com');
    expect(normalizeEmail('ale(at)example.com')).toBeUndefined();
    const p = mergeProfile(emptyProfile(), { email: 'Ale@Example.com' }, chat).profile;
    expect(p.email).toBe('ale@example.com');
    const edited = replaceProfileByUser(
      p,
      { fields: { email: 'ufficio@example.com' }, family: [] },
      at,
    ).profile;
    const r = mergeProfile(edited, { email: 'altro@example.com' }, chat);
    expect(r.profile.email).toBe('ufficio@example.com');
    expect(r.conflicts[0]).toMatchObject({ field: 'email', after: 'altro@example.com' });
    expect(renderProfile(edited, at)).toContain('Email: ufficio@example.com');
  });
});

describe('luoghi della scheda (promemoria geolocalizzati)', () => {
  const at = new Date('2026-10-15T10:00:00Z');
  it('dalla chat: aggiunge o aggiorna l’indirizzo e azzera le coordinate; non tocca quelli scritti nell’app', () => {
    const first = mergeProfile(
      emptyProfile(),
      { places: [{ label: 'Casa mia', address: 'via Roma 3, Treviso' }, { label: 'lavoro' }] },
      { source: 'conversation', at },
    );
    expect(first.profile.places).toMatchObject([{ label: 'casa', address: 'via Roma 3, Treviso' }]);
    expect(first.changes).toHaveLength(1);
    const id = first.profile.places[0]?.id ?? '';
    const located = setPlaceCoordinates(first.profile, id, { lat: 45.66, lng: 12.24 });
    expect(located.profile.places[0]).toMatchObject({
      lat: 45.66,
      lng: 12.24,
      address: 'via Roma 3, Treviso',
    });
    expect(setPlaceCoordinates(first.profile, 'nessuno', { lat: 45, lng: 12 }).changes).toEqual([]);
    expect(setPlaceCoordinates(first.profile, id, { lat: 0, lng: 0 }).changes).toEqual([]);

    const moved = mergeProfile(
      located.profile,
      { places: [{ label: 'casa', address: 'via Verdi 10, Treviso' }] },
      { source: 'conversation', at },
    );
    expect(moved.profile.places[0]).toMatchObject({ id, address: 'via Verdi 10, Treviso' });
    expect(moved.profile.places[0]?.lat).toBeUndefined();

    // Scritto dall'utente nell'app (con la mappa): la chat non lo cambia, segnala il contrasto.
    const byUser = replaceProfileByUser(
      moved.profile,
      {
        fields: {},
        family: [],
        places: [
          {
            id,
            label: 'Casa',
            address: 'via Verdi 10, Treviso',
            lat: 45.67,
            lng: 12.25,
            radius: 300,
          },
        ],
      },
      at,
    );
    expect(byUser.profile.places[0]).toMatchObject({ label: 'casa', lat: 45.67, radius: 300 });
    const fromChat = mergeProfile(
      byUser.profile,
      { places: [{ label: 'casa', address: 'via Bianchi 1, Treviso' }] },
      { source: 'conversation', at },
    );
    expect(fromChat.profile.places[0]?.address).toBe('via Verdi 10, Treviso');
    expect(fromChat.conflicts[0]).toMatchObject({ field: 'places', conflict: true });

    // Un'app vecchia (senza luoghi nella richiesta) non li cancella.
    const oldApp = replaceProfileByUser(byUser.profile, { fields: {}, family: [] }, at);
    expect(oldApp.profile.places).toHaveLength(1);
    expect(findPlace(oldApp.profile, 'la casa')?.id).toBe(id);
    expect(renderProfile(oldApp.profile, at)).toContain('Luoghi: casa: via Verdi 10, Treviso');
  });

  it('upsertPlace e normalizePlaceLabel', () => {
    const p = emptyProfile();
    const meta = { source: 'conversation' as const, at: at.toISOString() };
    expect(
      upsertPlace(p, { label: 'Il mio ufficio', address: 'corso Italia 10, Roma' }, meta),
    ).toMatchObject({
      label: 'ufficio',
    });
    expect(findPlace(p, 'lavoro')?.label).toBe('ufficio');
    expect(normalizePlaceLabel('  La palestra ')).toBe('palestra');
    expect(upsertPlace(p, { label: 'casa', address: '' }, meta)).toBeNull();
  });
});

describe('nomi dei luoghi dati in chat', () => {
  const meta = { source: 'user' as const, at: '2026-10-15T10:00:00.000Z' };
  it('posizione attuale con un nome (zona dalla precisione) e rinomina', () => {
    const p = emptyProfile();
    const a = placeHere(p, { label: 'Casa al mare', lat: 45.5, lng: 12.6, accuracyM: 240 }, meta);
    expect(a).toMatchObject({ label: 'casa al mare', lat: 45.5, radius: 400 });
    const moved = placeHere(
      p,
      { label: 'casa al mare', lat: 45.51, lng: 12.61, accuracyM: 20 },
      meta,
    );
    expect(moved?.id).toBe(a?.id);
    expect(moved?.radius).toBe(400);
    placeHere(p, { label: 'palestra', lat: 45.4, lng: 12.3 }, meta);
    const r = renamePlace(p, 'Casa al mare', 'Villa', meta);
    expect(r).toMatchObject({ ok: true, from: 'casa al mare', to: 'villa' });
    if (!r.ok) throw new Error('atteso ok');
    expect(r.profile.places.map((x) => x.label)).toEqual(['villa', 'palestra']);
    expect(renamePlace(r.profile, 'villa', 'palestra', meta)).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect(renamePlace(r.profile, 'piscina', 'mare', meta)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});
