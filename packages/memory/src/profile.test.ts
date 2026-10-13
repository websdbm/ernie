import { describe, expect, it } from 'vitest';
import {
  describeBirthDate,
  emptyProfile,
  formatProfileNotices,
  mergeProfile,
  normalizeBirthDate,
  renderProfile,
  replaceProfileByUser,
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
