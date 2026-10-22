import { describe, expect, it } from 'vitest';
import {
  consolidateFamily,
  emptyProfile,
  memoryProfileStore,
  type UserProfile,
} from './profile.js';

const profile = (): UserProfile => ({
  ...emptyProfile(),
  city: 'Roma',
  family: [
    {
      id: 'canonical',
      name: 'Anna Rossi',
      relation: 'compagna',
      birthDate: '1980-01-01',
      meta: { source: 'user', at: '2026-01-01' },
    },
    {
      id: 'alias',
      name: 'Anna',
      relation: 'compagna',
      notes: 'Numero scarpe: 41',
      meta: { source: 'conversation', at: '2026-10-17' },
    },
  ],
});
describe('consolidamento di identità già unite nel Brain', () => {
  it('conserva id canonico, metadati, nascita e note e non ripete revisioni', async () => {
    const store = memoryProfileStore();
    await store.save(
      'user',
      profile(),
      [{ field: 'family', before: null, after: 'inizio' }],
      'user',
    );
    expect(await store.consolidateFamily('user', 'Anna Rossi', ['Anna'])).toEqual({
      changed: true,
      question: null,
    });
    const next = await store.get('user');
    expect(next.city).toBe('Roma');
    expect(next.family).toHaveLength(1);
    expect(next.family[0]).toMatchObject({
      id: 'canonical',
      name: 'Anna Rossi',
      birthDate: '1980-01-01',
      notes: 'Numero scarpe: 41',
      meta: { source: 'user' },
    });
    expect(await store.consolidateFamily('user', 'Anna Rossi', ['Anna'])).toEqual({
      changed: false,
      question: null,
    });
    expect(store.revisions).toHaveLength(2);
  });
  it('chiede in caso di dati discordanti e non tronca note troppo lunghe', () => {
    const p = profile();
    const first = p.family[0];
    const second = p.family[1];
    if (!first || !second) throw new Error('fixture');
    second.birthDate = '1981-02-03';
    expect(consolidateFamily(p, 'Anna Rossi', ['Anna'])).toMatchObject({
      profile: p,
      changes: [],
      question: expect.any(String),
    });
    delete second.birthDate;
    first.notes = 'a'.repeat(100);
    second.notes = 'b'.repeat(100);
    expect(consolidateFamily(p, 'Anna Rossi', ['Anna']).changes).toEqual([]);
  });
  it('non deduce identità simili e non unisce omonimi multipli nella scheda', () => {
    expect(consolidateFamily(profile(), 'Gianna Rossi', ['Gianna']).changes).toEqual([]);
    const p = profile();
    const second = p.family[1];
    if (!second) throw new Error('fixture');
    p.family.push({ ...second, id: 'another' });
    expect(consolidateFamily(p, 'Anna Rossi', ['Anna']).question).toBeTruthy();
  });
});
