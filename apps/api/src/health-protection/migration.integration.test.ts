import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthCipher, type HealthCipher } from './crypto.js';
import { createHealthMigration, healthMigrationId } from './migration.js';
import { createEncryptedHealthSourceStore } from './sources.js';
import { createEncryptedHealthStore } from './store.js';

const TEST_ENV = '/tmp/ernie-health-protection-db.env';
const ownerUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
const ready =
  process.env.ERNIE_HEALTH_PROTECTION_TEST_ENV === TEST_ENV &&
  existsSync(TEST_ENV) &&
  [ownerUrl, appUrl].every((raw) => {
    if (!raw) return false;
    try {
      const u = new URL(raw);
      return (
        ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
        u.pathname === '/ernie' &&
        Number(u.port) > 1024
      );
    } catch {
      return false;
    }
  });
const defined = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('Missing synthetic fixture');
  return value;
};
const unavailable = { code: 'health_data_unavailable' };
describe.skipIf(!ready)(
  'explicit account health migration (disposable synthetic PostgreSQL)',
  () => {
    let app: Pool;
    let owner: Pool;
    const users: string[] = [];
    const cipher = createHealthCipher({
      activeKeyId: 'migration',
      keys: new Map([['migration', Buffer.alloc(32, 44)]]),
    });
    const user = async () => {
      const id = randomUUID();
      await owner.query("INSERT INTO users(id,display_name) VALUES($1,'Synthetic migration')", [
        id,
      ]);
      users.push(id);
      return id;
    };
    const fixture = async (
      u: string,
      opts: {
        doc?: string;
        withoutOriginal?: boolean;
        pages?: string[];
        date?: string | null;
      } = {},
    ) => {
      const id = randomUUID();
      const documentId = opts.withoutOriginal ? null : (opts.doc ?? randomUUID());
      const page = opts.pages ?? ['OCR referto sintetico 🧸 — contenuto originale'];
      if (documentId && !opts.doc)
        await owner.query(
          `INSERT INTO documents(id,user_id,title,source,language,pages,chars,page_texts,body,products,schemas)
      VALUES($1,$2,'Titolo medico sintetico','scan','it',$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb)`,
          [
            documentId,
            u,
            page.length,
            page.join('\n\n').length,
            JSON.stringify(page),
            page.join('\n\n'),
            JSON.stringify({ abstract: 'derivato sintetico privato' }),
            JSON.stringify({ synthetic: 'schema privato' }),
          ],
        );
      await owner.query(
        "INSERT INTO health_reports(id,user_id,taken_on,lab,kind,document_id,note_path) VALUES($1,$2,$3,'Laboratorio sintetico privato','tipo sintetico',$4,'Salute/Referto sintetico.md')",
        [id, u, opts.date ?? null, documentId],
      );
      const valueId = randomUUID();
      await owner.query(
        `INSERT INTO health_values(id,user_id,report_id,parameter,label,value,unit,ref_low,ref_high,ref_text,flag)
      VALUES($1,$2,$3,'synthetic','Valore sintetico',12.5,'unità sintetica',NULL,NULL,'nessun riferimento','n/d')`,
        [valueId, u, id],
      );
      const notice = (
        await owner.query(
          "INSERT INTO health_notices(user_id,report_id,text) VALUES($1,$2,'Avviso sintetico privato') RETURNING id",
          [u, id],
        )
      ).rows[0].id as string;
      return { id, documentId, valueId, notice, page };
    };
    beforeAll(async () => {
      owner = createPool({ connectionString: ownerUrl as string });
      app = createPool({ connectionString: appUrl as string, max: 4 });
      expect(
        (
          await app.query(
            'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
          )
        ).rows[0],
      ).toEqual({ name: 'ernie_app', rolsuper: false, rolbypassrls: false });
    });
    afterAll(async () => {
      try {
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally {
        await app?.end();
        await owner?.end();
        cipher.destroy();
      }
    });
    it('defaults to a read-only plan with a scoped fingerprint and no medical contents', async () => {
      const a = await user();
      const b = await user();
      await fixture(a);
      await fixture(b);
      const migration = createHealthMigration(app, cipher);
      const review = await migration.run(a);
      expect(review.counts).toMatchObject({ reports: 1, values: 1, notices: 1, documents: 1 });
      expect(review).not.toHaveProperty('applied');
      expect(JSON.stringify(review)).not.toContain('sintetico');
      expect(review.copies.transcripts).toBe('requires_external_inventory');
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM health_secure_reports WHERE user_id=$1',
            [a],
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await migration.dryRun(b)).fingerprint).not.toBe(review.fingerprint);
      await expect(migration.apply(b, review.fingerprint)).rejects.toMatchObject(unavailable);
    });
    it('copies, decrypts and verifies all data before scrub; preserves IDs/null dates and repeated apply', async () => {
      const u = await user();
      const f = await fixture(u);
      const unrelated = await fixture(await user());
      await owner.query(
        'INSERT INTO document_chunks(user_id,document_id,page,ordinal,content,content_hash) VALUES($1,$2,1,0,$3,$4)',
        [u, f.documentId, 'Frammento sanitario sintetico', 'synthetichash'],
      );
      const migration = createHealthMigration(app, cipher);
      const review = await migration.dryRun(u);
      const result = await migration.apply(u, review.fingerprint);
      expect(result).toMatchObject({ applied: true, alreadyApplied: false });
      const store = createEncryptedHealthStore(app, cipher);
      expect(await store.report(u, f.id)).toMatchObject({
        id: f.id,
        takenOn: null,
        lab: 'Laboratorio sintetico privato',
        values: 1,
      });
      expect((await store.reportValues(u, f.id))[0]).toMatchObject({
        value: 12.5,
        refLow: null,
        refHigh: null,
        flag: 'n/d',
      });
      expect((await store.pendingNotices(u))[0]?.id).toBe(
        healthMigrationId(u, 'notice', String(f.notice)),
      );
      const sources = createEncryptedHealthSourceStore(app, cipher);
      expect((await sources.get(u, defined(f.documentId)))?.pages).toEqual(f.page);
      const original = await sources.legacy(
        u,
        healthMigrationId(u, 'document', defined(f.documentId)),
      );
      expect(original?.contents).toMatchObject({
        document: { products: { abstract: 'derivato sintetico privato' } },
        chunks: [{ content: 'Frammento sanitario sintetico' }],
      });
      expect(
        (
          await owner.query(
            'SELECT title,body,page_texts,products,schemas,status FROM documents WHERE id=$1',
            [f.documentId],
          )
        ).rows[0],
      ).toEqual({
        title: 'Documento protetto',
        body: '',
        page_texts: [],
        products: null,
        schemas: {},
        status: 'deleted',
      });
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM document_chunks WHERE user_id=$1', [u]))
          .rows[0].n,
      ).toBe(0);
      expect(
        (
          await owner.query(
            'SELECT kind,taken_on,lab,note_path,document_id FROM health_reports WHERE user_id=$1',
            [u],
          )
        ).rows[0],
      ).toEqual({
        kind: '[protected]',
        taken_on: null,
        lab: null,
        note_path: null,
        document_id: null,
      });
      for (const table of ['health_values', 'health_notices'])
        expect(
          (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [u]))
            .rows[0].n,
        ).toBe(0);
      expect(
        (await owner.query('SELECT kind FROM health_reports WHERE id=$1', [unrelated.id])).rows[0]
          .kind,
      ).toBe('tipo sintetico');
      expect(await migration.apply(u, review.fingerprint)).toMatchObject({ alreadyApplied: true });
      expect((await migration.dryRun(u)).counts.reports).toBe(0);
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM health_privacy WHERE user_id=$1', [u]))
          .rows[0].n,
      ).toBe(0);
    });
    it('rejects a stale fingerprint without mutations', async () => {
      const u = await user();
      const f = await fixture(u);
      const migration = createHealthMigration(app, cipher);
      const review = await migration.dryRun(u);
      await owner.query('UPDATE health_values SET value=13 WHERE id=$1', [f.valueId]);
      await expect(migration.apply(u, review.fingerprint)).rejects.toMatchObject(unavailable);
      expect(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM health_secure_sources WHERE user_id=$1',
            [u],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await owner.query('SELECT status FROM documents WHERE id=$1', [f.documentId])).rows[0]
          .status,
      ).toBe('ready');
    });

    it('preserves calendar dates and timestamp milliseconds exactly', async () => {
      const u = await user();
      const f = await fixture(u, { date: '2026-06-02' });
      await owner.query(
        "UPDATE health_reports SET created_at='2026-06-03T10:11:12.789Z' WHERE id=$1",
        [f.id],
      );
      await owner.query(
        "UPDATE health_notices SET created_at='2026-06-03T10:11:13.456Z',notified_at='2026-06-03T10:12:13.987Z' WHERE id=$1",
        [f.notice],
      );
      const migration = createHealthMigration(app, cipher);
      await migration.apply(u, (await migration.dryRun(u)).fingerprint);
      expect((await createEncryptedHealthStore(app, cipher).report(u, f.id))?.takenOn).toBe(
        '2026-06-02',
      );
      expect(
        (
          await owner.query(
            'SELECT created_at FROM health_secure_reports WHERE user_id=$1 AND id=$2',
            [u, f.id],
          )
        ).rows[0].created_at.toISOString(),
      ).toBe('2026-06-03T10:11:12.789Z');
      const notice = (
        await owner.query(
          'SELECT created_at,notified_at FROM health_secure_notices WHERE user_id=$1',
          [u],
        )
      ).rows[0];
      expect(notice.created_at.toISOString()).toBe('2026-06-03T10:11:13.456Z');
      expect(notice.notified_at.toISOString()).toBe('2026-06-03T10:12:13.987Z');
    });
    it('rolls back every encrypted write and leaves plaintext intact if verification fails', async () => {
      const u = await user();
      const f = await fixture(u);
      let calls = 0;
      const broken: HealthCipher = {
        ...cipher,
        decrypt(ctx, value) {
          calls++;
          if (ctx.resourceKind === 'report') throw new Error('synthetic failure');
          return cipher.decrypt(ctx, value);
        },
      };
      const migration = createHealthMigration(app, broken);
      const review = await migration.dryRun(u);
      await expect(migration.apply(u, review.fingerprint)).rejects.toMatchObject(unavailable);
      expect(calls).toBeGreaterThan(0);
      for (const table of [
        'health_secure_sources',
        'health_secure_reports',
        'health_secure_notices',
        'health_secure_legacy_resources',
      ])
        expect(
          (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [u]))
            .rows[0].n,
        ).toBe(0);
      expect(
        (await owner.query('SELECT body,status FROM documents WHERE id=$1', [f.documentId]))
          .rows[0],
      ).toEqual({ body: f.page[0], status: 'ready' });
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM health_values WHERE user_id=$1', [u]))
          .rows[0].n,
      ).toBe(1);
    });
    it('preserves uncertain foreign source references and invalid payloads while migrating eligible reports', async () => {
      const a = await user();
      const b = await user();
      const foreign = await fixture(b);
      const invalid = await fixture(a, { doc: defined(foreign.documentId) });
      const valid = await fixture(a, { withoutOriginal: true });
      const migration = createHealthMigration(app, cipher);
      const review = await migration.dryRun(a);
      expect(review.blockers).toContainEqual({
        kind: 'report',
        id: invalid.id,
        code: 'source_missing_or_not_owned',
      });
      expect(review.warnings).toContainEqual({
        kind: 'report',
        id: valid.id,
        code: 'original_unavailable',
      });
      expect(review.eligible.reports).toBe(1);
      await migration.apply(a, review.fingerprint);
      expect(
        (await owner.query('SELECT kind FROM health_reports WHERE id=$1', [invalid.id])).rows[0]
          .kind,
      ).toBe('tipo sintetico');
      expect((await createEncryptedHealthStore(app, cipher).reports(a)).map((r) => r.id)).toEqual([
        valid.id,
      ]);
    });
    it('does not cascade-delete corrupt child references belonging to another account', async () => {
      const a = await user();
      const b = await user();
      const f = await fixture(a);
      const foreignValue = randomUUID();
      await owner.query(
        "INSERT INTO health_values(id,user_id,report_id,parameter,label,value) VALUES($1,$2,$3,'foreign','Foreign synthetic',99)",
        [foreignValue, b, f.id],
      );
      const foreignNotice = (
        await owner.query(
          "INSERT INTO health_notices(user_id,report_id,text) VALUES($1,$2,'Foreign synthetic notice') RETURNING id",
          [b, f.id],
        )
      ).rows[0].id;
      const migration = createHealthMigration(app, cipher);
      await migration.apply(a, (await migration.dryRun(a)).fingerprint);
      expect(
        (
          await withUser(app, b, (c) =>
            c.query('SELECT value FROM health_values WHERE id=$1', [foreignValue]),
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await withUser(app, b, (c) =>
            c.query('SELECT text FROM health_notices WHERE id=$1', [foreignNotice]),
          )
        ).rowCount,
      ).toBe(1);
    });
    it('archives exact OCR media as an accessible original; keeps ambiguous media and all Brain notes', async () => {
      const u = await user();
      const f = await fixture(u);
      const mediaId = randomUUID();
      const image = Buffer.from([255, 216, 255, 217]);
      await owner.query(
        `INSERT INTO brain_notes(user_id,path,title,note_type,created,content_hash) VALUES($1,'Salute/Referto sintetico.md','Nota sintetica','salute',now(),'synthetic')`,
        [u],
      );
      const addMedia = async (id: string, ocr: string, hash: string) =>
        owner.query(
          `INSERT INTO media_items(id,user_id,client_id,sha256,image_bytes,thumbnail_bytes,width,height,title,ocr_text,source,brain_links)
      VALUES($1,$2,$1,$3,$4,$4,1,1,'Foto sintetica',$5,'scan',ARRAY['Salute/Referto sintetico.md'])`,
          [id, u, hash, image, ocr],
        );
      await addMedia(mediaId, defined(f.page[0]), 'a'.repeat(64));
      const ambiguous = randomUUID();
      await addMedia(ambiguous, 'OCR diverso ma nota collegata', 'b'.repeat(64));
      const migration = createHealthMigration(app, cipher);
      const review = await migration.dryRun(u);
      expect(review.eligible.exactMedia).toBe(1);
      expect(review.copies.brainNotes).toBe(1);
      expect(review.warnings).toContainEqual({
        kind: 'media',
        id: ambiguous,
        code: 'ambiguous_or_excess_media_preserved',
      });
      await migration.apply(u, review.fingerprint);
      const source = createEncryptedHealthSourceStore(app, cipher);
      expect((await source.get(u, defined(f.documentId)))?.attachments).toContainEqual(
        expect.objectContaining({ id: mediaId, bytes: image.length }),
      );
      expect((await source.attachment(u, defined(f.documentId), mediaId))?.dataBase64).toBe(
        image.toString('base64'),
      );
      expect(
        (await source.legacy(u, healthMigrationId(u, 'media', mediaId)))?.contents,
      ).toMatchObject({ imageBase64: image.toString('base64') });
      expect((await owner.query('SELECT id FROM media_items WHERE user_id=$1', [u])).rows).toEqual([
        { id: ambiguous },
      ]);
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM brain_notes WHERE user_id=$1', [u]))
          .rows[0].n,
      ).toBe(1);
    });
    it('migrates values when the original was already deliberately deleted without claiming OCR coverage', async () => {
      const u = await user();
      const f = await fixture(u);
      await owner.query(
        "UPDATE documents SET status='deleted',body='',page_texts='[]' WHERE id=$1",
        [f.documentId],
      );
      const migration = createHealthMigration(app, cipher);
      const review = await migration.dryRun(u);
      expect(review.blockers).toEqual([]);
      expect(review.eligible.documents).toBe(0);
      expect(review.warnings).toContainEqual({
        kind: 'report',
        id: f.id,
        code: 'original_unavailable',
      });
      await migration.apply(u, review.fingerprint);
      expect(await createEncryptedHealthStore(app, cipher).report(u, f.id)).not.toBeNull();
      expect(
        await createEncryptedHealthSourceStore(app, cipher).get(u, defined(f.documentId)),
      ).toBeNull();
      expect(
        (
          await owner.query('SELECT title,products,schemas FROM documents WHERE id=$1', [
            f.documentId,
          ])
        ).rows[0],
      ).toEqual({ title: 'Documento protetto', products: null, schemas: {} });
      expect(
        (
          await createEncryptedHealthSourceStore(app, cipher).legacy(
            u,
            healthMigrationId(u, 'document', defined(f.documentId)),
          )
        )?.contents,
      ).toMatchObject({ document: { products: { abstract: 'derivato sintetico privato' } } });
    });
  },
);
