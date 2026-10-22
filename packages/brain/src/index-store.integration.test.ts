import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrainIndex } from './index-store.js';
import { parseNote } from './note.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('indice del second brain (Postgres, RLS, filtri)', () => {
  let owner: Pool;
  let app: Pool;
  const user = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 3 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'B'), ($2, 'C')`, [
      user,
      other,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[user, other]]);
    await owner.end();
    await app.end();
  });

  it('anteprime e risultati non contengono commenti tecnici, anche dopo reindicizzazione', async () => {
    const index = createBrainIndex(app, null);
    const note = parseNote(
      'Persone/Anna.md',
      '# Anna\n\n<!-- ernie:family-profile abc123 -->\nCompagna: ama la montagna.\n<!-- /ernie:family-profile -->',
    );
    await index.upsert(user, note);
    const read = await index.get(user, note.path);
    expect(read?.excerpt).toBe('Compagna: ama la montagna.');
    const hits = await index.search(user, { query: 'montagna' });
    expect(hits[0]?.passage).toContain('ama la montagna');
    expect(hits[0]?.passage).not.toContain('ernie:');
    expect(hits[0]?.passage).not.toContain('abc123');
    expect(await index.upsert(user, note)).toBe(false);
    await index.remove(user, note.path);
  });

  it('cerca per parole, filtra per tempo, luogo, vicinanza e collegamenti; le riservate solo se chieste', async () => {
    const index = createBrainIndex(app, null);
    const note = (path: string, front: string, body: string) =>
      parseNote(path, `---\n${front}\n---\n\n${body}`);
    await index.upsert(
      user,
      note(
        'Note/Caldaia.md',
        'tipo: nota\ncreata: 2026-03-02T10:00\nluogo: Padova\ncoordinate: [45.41, 11.88]\ncollegamenti:\n  - "[[Casa]]"',
        'Il codice di assistenza della caldaia è 4471.',
      ),
    );
    await index.upsert(
      user,
      note(
        'Note/Gita.md',
        'tipo: nota\ncreata: 2026-10-13T09:00\nriguarda: 2026-10-14\nluogo: Verona\ncoordinate: [45.44, 10.99]',
        'Gita al museo: portare il modulo firmato.',
      ),
    );
    await index.upsert(
      user,
      note(
        'Note/Analisi.md',
        'tipo: nota\ncreata: 2026-09-01T09:00\nriservata: true',
        'Analisi del sangue: colesterolo nella norma.',
      ),
    );
    expect(
      await index.upsert(
        user,
        note(
          'Note/Gita.md',
          'tipo: nota\ncreata: 2026-10-13T09:00\nriguarda: 2026-10-14\nluogo: Verona\ncoordinate: [45.44, 10.99]',
          'Gita al museo: portare il modulo firmato.',
        ),
      ),
    ).toBe(false);

    expect((await index.search(user, { query: 'qual è il codice della caldaia?' }))[0]?.title).toBe(
      'Caldaia',
    );
    expect((await index.search(user, { query: 'colesterolo' })).map((h) => h.title)).toEqual([]);
    expect(
      (await index.search(user, { query: 'colesterolo', includePrivate: true }))[0]?.title,
    ).toBe('Analisi');
    expect(
      (await index.list(user, { from: '2026-10-01', to: '2026-10-31' })).map((n) => n.title),
    ).toEqual(['Gita']);
    expect((await index.list(user, { place: 'pado' })).map((n) => n.title)).toEqual(['Caldaia']);
    expect(
      (await index.list(user, { near: [45.4, 11.87], radiusKm: 5 })).map((n) => n.title),
    ).toEqual(['Caldaia']);
    expect((await index.list(user, { linkedTo: 'casa' })).map((n) => n.title)).toEqual(['Caldaia']);
    expect((await index.findByTitle(user, 'gita'))?.path).toBe('Note/Gita.md');
    expect(await index.list(other)).toEqual([]);
    // Suggerimenti: abbastanza parole in comune o titolo citato; mai le riservate; esclusioni per sessione.
    expect(
      (await index.suggest(user, 'domani viene il tecnico per la caldaia, cosa gli dico?'))?.title,
    ).toBe('Caldaia');
    expect(await index.suggest(user, 'che tempo fa domani a Roma?')).toBeNull();
    expect(await index.suggest(user, 'ho fatto le analisi del sangue, colesterolo?')).toBeNull();
    expect(
      await index.suggest(user, 'domani viene il tecnico per la caldaia', ['Note/Caldaia.md']),
    ).toBeNull();
    await index.remove(user, 'Note/Gita.md');
    expect(await index.count(user)).toBe(2);
  });
});
