import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChunkStore } from './chunks.js';
import { createDocumentRepository } from './repository.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('pezzi dei documenti (Postgres, full-text italiano, RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const user = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'D'), ($2, 'O')`, [
      user,
      other,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[user, other]]);
    await owner.end();
    await app.end();
  });

  it('indicizza, cerca con la pagina, trova le pagine di una sezione, isola gli utenti', async () => {
    const repo = createDocumentRepository(app);
    const pages = [
      'Capitolo 1\nLa preistoria\nGli uomini del Paleolitico erano cacciatori e raccoglitori.',
      'Capitolo 2\nI Sumeri\nI Sumeri fondarono città-stato come Uruk e Ur.',
      'Il re era detto Lugal e governava dalla ziqqurat.',
      'Capitolo 3\nGli Egizi\nGli Egizi vivevano lungo il Nilo.',
    ];
    const doc = await repo.create(user, { source: 'scan', pageTexts: pages, title: 'Storia' });
    const store = createChunkStore(app, null);
    expect(await store.hasChunks(user, doc.id)).toBe(false);
    expect(await store.index(user, doc.id, pages)).toBeGreaterThanOrEqual(4);
    const hits = await store.search(user, {
      query: 'come si chiamava il re Lugal?',
      documentId: doc.id,
    });
    expect(hits[0]).toMatchObject({ page: 3, title: 'Storia' });
    expect(await store.sectionPages(user, doc.id, 'capitolo 2')).toEqual({
      fromPage: 2,
      toPage: 3,
    });
    expect(await store.sectionPages(user, doc.id, 'Egizi')).toEqual({ fromPage: 4, toPage: 4 });
    const scoped = await store.search(user, {
      query: 'Nilo',
      documentId: doc.id,
      fromPage: 2,
      toPage: 3,
    });
    expect(scoped).toEqual([]);
    expect(await store.search(other, { query: 'Lugal' })).toEqual([]);
  });
});
