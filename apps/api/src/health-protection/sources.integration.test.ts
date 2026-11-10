import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthCipher } from './crypto.js';
import {
  createEncryptedHealthSourceStore,
  type HealthSourceInput,
  lockHealthSource,
} from './sources.js';
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
const firstAsset = (value: HealthSourceInput) => defined(value.attachments?.[0]);
const unavailable = { code: 'health_data_unavailable' };
const input = (overrides: Partial<HealthSourceInput> = {}): HealthSourceInput => ({
  id: randomUUID(),
  title: 'Titolo originale sintetico 🧸',
  source: 'scan',
  pages: ['OCR sintetico privato — αβ'],
  attachments: [
    {
      id: randomUUID(),
      name: 'Originale sintetico.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('synthetic image bytes').toString('base64'),
    },
  ],
  ...overrides,
});

describe.skipIf(!ready)('encrypted health originals (disposable PostgreSQL)', () => {
  let owner: Pool;
  let app: Pool;
  const users: string[] = [];
  const cipher = createHealthCipher({
    activeKeyId: 'test',
    keys: new Map([['test', Buffer.alloc(32, 61)]]),
  });
  const user = async () => {
    const id = randomUUID();
    await owner.query("INSERT INTO users(id,display_name) VALUES($1,'Synthetic health sources')", [
      id,
    ]);
    users.push(id);
    return id;
  };
  beforeAll(async () => {
    owner = createPool({ connectionString: ownerUrl as string });
    app = createPool({ connectionString: appUrl as string, max: 5 });
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
  it('encrypts originals, title, OCR, names and input hash; manual read requires no AI consent', async () => {
    const u = await user();
    const value = input();
    const store = createEncryptedHealthSourceStore(app, cipher);
    expect(await store.save(u, value)).toMatchObject({
      id: value.id,
      pages: 1,
      status: 'pending',
      reportId: null,
    });
    expect(await store.get(u, value.id)).toMatchObject({
      title: value.title,
      pages: value.pages,
      attachments: [{ name: 'Originale sintetico.png', bytes: 21 }],
    });
    expect(await store.attachment(u, value.id, firstAsset(value).id)).toMatchObject(
      firstAsset(value),
    );
    const raw = JSON.stringify(
      (
        await owner.query(
          'SELECT row_to_json(s) AS data FROM health_secure_sources s WHERE user_id=$1 UNION ALL SELECT row_to_json(a) FROM health_secure_assets a WHERE user_id=$1',
          [u],
        )
      ).rows,
    );
    for (const secret of [
      value.title,
      value.pages[0],
      firstAsset(value).name,
      'synthetic image bytes',
      'inputHash',
    ])
      expect(raw).not.toContain(secret);
    expect((await store.get(u, value.id))?.attachments[0]).not.toHaveProperty('dataBase64');
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM health_privacy WHERE user_id=$1', [u]))
        .rows[0].n,
    ).toBe(0);
  });
  it('serializes simultaneous retries, accepts identical content and rejects conflicting IDs', async () => {
    const u = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const value = input();
    const results = await Promise.all([
      store.save(u, value),
      store.save(u, value),
      store.save(u, value),
    ]);
    expect(new Set(results.map((r) => r.createdAt)).size).toBe(1);
    await expect(store.save(u, { ...value, pages: ['contenuto diverso'] })).rejects.toMatchObject(
      unavailable,
    );
    expect((await store.list(u)).length).toBe(1);
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM health_secure_assets WHERE user_id=$1', [
          u,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
  it('rolls back a new source and earlier attachments when a later asset collides', async () => {
    const u = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const first = input();
    await store.save(u, first);
    const second = input({ attachments: [firstAsset(input()), firstAsset(first)] });
    await expect(store.save(u, second)).rejects.toMatchObject(unavailable);
    expect(await store.get(u, second.id)).toBeNull();
    expect(
      (
        await owner.query('SELECT count(*)::int AS n FROM health_secure_assets WHERE user_id=$1', [
          u,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
  it('enforces account RLS and composite source ownership, including same source UUID across users', async () => {
    const a = await user();
    const b = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const value = input();
    await store.save(a, value);
    expect(await store.get(b, value.id)).toBeNull();
    expect(await store.remove(b, value.id)).toBe(false);
    expect(
      (
        await withUser(app, b, (c) =>
          c.query('SELECT * FROM health_secure_sources WHERE user_id=$1', [a]),
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      withUser(app, b, (c) =>
        c.query(
          'INSERT INTO health_secure_assets(user_id,id,source_id,envelope) VALUES($1,$2,$3,$4)',
          [b, randomUUID(), value.id, {}],
        ),
      ),
    ).rejects.toBeTruthy();
    await store.save(b, { ...value, title: 'altro account' });
    expect((await store.get(a, value.id))?.title).toBe(value.title);
  });
  it('fails closed when source or asset envelopes cross account/record boundaries', async () => {
    const a = await user();
    const b = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const first = input();
    const second = input();
    await store.save(a, first);
    await store.save(a, second);
    await store.save(b, first);
    await owner.query(
      'UPDATE health_secure_sources SET envelope=(SELECT envelope FROM health_secure_sources WHERE user_id=$1 AND id=$2) WHERE user_id=$3 AND id=$2',
      [a, first.id, b],
    );
    await expect(store.get(b, first.id)).rejects.toMatchObject(unavailable);
    await owner.query(
      'UPDATE health_secure_assets SET envelope=(SELECT envelope FROM health_secure_assets WHERE user_id=$1 AND id=$2) WHERE user_id=$1 AND id=$3',
      [a, firstAsset(first).id, firstAsset(second).id],
    );
    await expect(store.attachment(a, second.id, firstAsset(second).id)).rejects.toMatchObject(
      unavailable,
    );
  });
  it('rejects invalid base64, duplicate assets and oversized OCR/files before storing rows', async () => {
    const u = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const base = input();
    const asset = firstAsset(base);
    const invalid = [
      input({ pages: ['x'.repeat(400001)] }),
      input({ attachments: [asset, asset] }),
      input({ attachments: [{ ...asset, dataBase64: 'not base64' }] }),
      input({
        attachments: [
          { ...asset, dataBase64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') },
        ],
      }),
      input({
        attachments: [
          {
            ...asset,
            mimeType: 'application/pdf',
            dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
          },
        ],
      }),
    ];
    for (const value of invalid)
      await expect(store.save(u, value)).rejects.toMatchObject(unavailable);
    expect(await store.list(u)).toEqual([]);
    const pdf = input({
      source: 'pdf',
      attachments: [
        {
          ...asset,
          mimeType: 'application/pdf',
          dataBase64: Buffer.alloc(3 * 1024 * 1024 + 1, 1).toString('base64'),
        },
      ],
    });
    await store.save(u, pdf);
    expect((await store.get(u, pdf.id))?.attachments[0]?.bytes).toBe(3 * 1024 * 1024 + 1);
  });
  it('deletes one lineage atomically while preserving another source/account and rejecting late analysis', async () => {
    const u = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const value = input();
    const other = input();
    await store.save(u, value);
    await store.save(u, other);
    const reports = createEncryptedHealthStore(app, cipher, {
      guardWrite: (owner, c) => lockHealthSource(c, owner, value.id),
    });
    const id = await reports.saveReport(
      u,
      { documentId: value.id, takenOn: null, lab: null, kind: 'synthetic' },
      [],
    );
    if (!id) throw new Error('fixture');
    await reports.addNotices(u, id, ['synthetic notice']);
    await store.archiveLegacy(u, {
      id: randomUUID(),
      sourceId: value.id,
      kind: 'note',
      originalId: 'synthetic.md',
      contents: 'original note',
    });
    expect(await store.list(u)).toContainEqual(
      expect.objectContaining({ id: value.id, status: 'analyzed', reportId: id }),
    );
    expect(await store.remove(u, value.id)).toBe(true);
    expect(await store.remove(u, value.id)).toBe(false);
    expect(await reports.report(u, id)).toBeNull();
    expect(await reports.pendingNotices(u)).toEqual([]);
    for (const table of ['health_secure_assets', 'health_secure_legacy_resources'])
      expect(
        (
          await owner.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1 AND source_id=$2`,
            [u, value.id],
          )
        ).rows[0].n,
      ).toBe(0);
    expect(await store.get(u, other.id)).not.toBeNull();
    await expect(
      reports.saveReport(u, { documentId: value.id, takenOn: null, lab: null, kind: 'late' }, []),
    ).rejects.toMatchObject(unavailable);
  });
  it('source locks serialize delete against a write already authorized in its transaction', async () => {
    const u = await user();
    const store = createEncryptedHealthSourceStore(app, cipher);
    const value = input();
    await store.save(u, value);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const locked = withUser(app, u, async (c) => {
      await lockHealthSource(c, u, value.id);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let removed = false;
    const removal = store.remove(u, value.id).then((x) => {
      removed = x;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toBe(false);
    release.resolve();
    await locked;
    await removal;
    expect(removed).toBe(true);
  });
});
