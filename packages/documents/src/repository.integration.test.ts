import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentRepository } from './repository.js';

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL;
const run = APP_URL && OWNER_URL ? describe : describe.skip;

run('repository dei documenti (Postgres, RLS)', async () => {
  const { Pool } = await import('pg');
  const app = new Pool({ connectionString: APP_URL });
  const owner = new Pool({ connectionString: OWNER_URL });
  const userA = randomUUID();
  const userB = randomUUID();
  beforeAll(async () => {
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'A'), ($2, 'B')`, [
      userA,
      userB,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('crea, cerca, salva prodotti e schemi, elimina; l’altro utente non vede nulla', async () => {
    const repo = createDocumentRepository(app);
    const meta = await repo.create(userA, {
      source: 'scan',
      pageTexts: [
        'La fotosintesi clorofilliana\nLe piante producono zuccheri.',
        'Seconda pagina sui cloroplasti.',
      ],
    });
    expect(meta.title).toBe('La fotosintesi clorofilliana');
    expect(meta.pages).toBe(2);
    expect(meta.status).toBe('ready');
    const found = await repo.list(userA, 'cloroplasti');
    expect(found.map((d) => d.id)).toEqual([meta.id]);
    expect(await repo.list(userB)).toEqual([]);
    expect(await repo.get(userB, meta.id)).toBeNull();

    await repo.saveProducts(
      userA,
      meta.id,
      {
        abstract: 'Riassunto.',
        keyPoints: ['uno'],
        glossary: [],
        questions: [],
        suggestedSchema: 'mindmap',
      },
      { type: 'mindmap', diagram: { type: 'mindmap', root: { label: 'Fotosintesi' } } },
    );
    await repo.saveSchema(userA, meta.id, 'timeline', {
      type: 'timeline',
      events: [
        { when: '1779', label: 'Scoperta' },
        { when: '1950', label: 'Calvin' },
      ],
    });
    const doc = await repo.get(userA, meta.id);
    expect(doc?.status).toBe('summarized');
    expect(doc?.products?.abstract).toBe('Riassunto.');
    expect(Object.keys(doc?.schemas ?? {}).sort()).toEqual(['mindmap', 'timeline']);
    expect(doc?.pageTexts.length).toBe(2);

    expect(await repo.remove(userA, meta.id)).toBe(true);
    expect(await repo.get(userA, meta.id)).toBeNull();
    await repo.saveProducts(userA, meta.id, {
      abstract: 'Risultato tardivo',
      keyPoints: [],
      glossary: [],
      questions: [],
      suggestedSchema: 'mindmap',
    });
    await repo.saveSchema(userA, meta.id, 'mindmap', {
      type: 'mindmap',
      root: { label: 'Tardivo' },
    });
    const removed = (
      await owner.query(
        `SELECT status,title,body,page_texts,products,schemas,chars,language
      FROM documents WHERE id=$1`,
        [meta.id],
      )
    ).rows[0];
    expect(removed).toEqual({
      status: 'deleted',
      title: 'Documento eliminato',
      body: '',
      page_texts: [],
      products: null,
      schemas: {},
      chars: 0,
      language: null,
    });
    expect(await repo.get(userA, meta.id)).toBeNull();
    await owner.query(
      "UPDATE documents SET title='Titolo residuo',body='Testo residuo' WHERE id=$1",
      [meta.id],
    );
    expect(await repo.remove(userA, meta.id)).toBe(false);
    expect(
      (await owner.query('SELECT title,body FROM documents WHERE id=$1', [meta.id])).rows[0],
    ).toEqual({ title: 'Documento eliminato', body: '' });
  });
});
