import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('con gli embedding la ricerca vettoriale si fonde con il full-text (parametri tipizzati)', async () => {
    const repo = createDocumentRepository(app);
    const pages = [
      'Capitolo 1\nI Sumeri\nInventarono la scrittura cuneiforme.',
      'Gli Assiri avevano capitale Ninive.',
    ];
    const doc = await repo.create(user, { source: 'scan', pageTexts: pages, title: 'Vettori' });
    // Vettore finto: una dimensione accesa per parola chiave, così «Ninive» punta alla pagina 2.
    const embedder = {
      model: 'fake',
      embed: async (texts: string[]) => ({
        vectors: texts.map((t) => {
          const v = new Array(1536).fill(0.001);
          if (/ninive/i.test(t)) v[0] = 1;
          if (/cuneiforme/i.test(t)) v[1] = 1;
          return v;
        }),
      }),
    };
    const store = createChunkStore(app, embedder);
    await store.index(user, doc.id, pages);
    const hits = await store.search(user, {
      query: 'dov’era la capitale Ninive?',
      documentId: doc.id,
    });
    expect(hits[0]).toMatchObject({ page: 2, title: 'Vettori' });
    const ranged = await store.search(user, {
      query: 'cuneiforme',
      documentId: doc.id,
      fromPage: 1,
      toPage: 1,
    });
    expect(ranged.map((h) => h.page)).toEqual([1]);
  });
  it('elimina i derivati, nasconde anche indici preesistenti e non tocca altri documenti', async () => {
    const repo = createDocumentRepository(app);
    const pages = ['Capitolo 1\nSegretissimo risultato sintetico conservato nel documento.'];
    const doc = await repo.create(user, { source: 'scan', pageTexts: pages });
    const survivor = await repo.create(other, { source: 'scan', pageTexts: pages });
    const embedder = {
      model: 'fake',
      embed: async (texts: string[]) => ({
        vectors: texts.map(() => Array(1536).fill(0.01)),
      }),
    };
    const store = createChunkStore(app, embedder);
    await store.index(user, doc.id, pages);
    await store.index(other, survivor.id, pages);
    const original = (
      await owner.query('SELECT * FROM document_chunks WHERE document_id=$1', [doc.id])
    ).rows[0];
    expect(await repo.remove(other, doc.id)).toBe(false);
    expect(await store.hasChunks(user, doc.id)).toBe(true);
    expect(await repo.remove(user, doc.id)).toBe(true);
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id=$1', [
          doc.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    // Simula un vecchio documento cancellato prima della bonifica degli indici.
    await owner.query(
      `INSERT INTO document_chunks (user_id,document_id,page,ordinal,heading,content,content_hash,embedding)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        user,
        doc.id,
        original.page,
        original.ordinal,
        original.heading,
        original.content,
        original.content_hash,
        original.embedding,
      ],
    );
    expect(await store.hasChunks(user, doc.id)).toBe(false);
    expect(await store.search(user, { query: 'Segretissimo', documentId: doc.id })).toEqual([]);
    expect(await store.sectionPages(user, doc.id, 'capitolo 1')).toBeNull();
    expect(await repo.list(user, 'Segretissimo')).toEqual([]);
    expect(await store.hasChunks(other, survivor.id)).toBe(true);
    expect(await repo.remove(user, doc.id)).toBe(false);
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id=$1', [
          doc.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('scarta gli embedding in volo dopo eliminazione', async () => {
    const repo = createDocumentRepository(app);
    const pages = ['Questo testo sintetico deve essere rimosso anche durante la indicizzazione.'];
    const doc = await repo.create(user, { source: 'scan', pageTexts: pages });
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ vectors: number[][] }>();
    const embed = vi.fn(async () => {
      started.resolve();
      return pending.promise;
    });
    const store = createChunkStore(app, { model: 'fake', embed });
    const indexing = store.index(user, doc.id, pages);
    await started.promise;
    await repo.remove(user, doc.id);
    pending.resolve({ vectors: [Array(1536).fill(0.01)] });
    expect(await indexing).toBe(0);
    expect(await store.hasChunks(user, doc.id)).toBe(false);
    expect(await store.index(user, doc.id, pages)).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id=$1', [
          doc.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
  it('non invia al provider un documento eliminato o appartenente a un altro utente', async () => {
    const repo = createDocumentRepository(app);
    const pages = ['Un testo privato sintetico da non inviare.'];
    const doc = await repo.create(user, { source: 'scan', pageTexts: pages });
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => Array(1536).fill(0.01)),
    }));
    const store = createChunkStore(app, { model: 'fake', embed });
    await expect(store.index(other, doc.id, pages)).resolves.toBe(0);
    expect(embed).not.toHaveBeenCalled();
    await repo.remove(user, doc.id);
    expect(await store.index(user, doc.id, pages)).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });
});
