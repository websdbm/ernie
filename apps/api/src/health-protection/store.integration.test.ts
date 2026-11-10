import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type HealthValue, trendOf } from '@ernie/brain';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHealthConsentStore, HEALTH_AI_POLICY_VERSION } from './consent.js';
import { createHealthCipher, HealthProtectionError } from './crypto.js';
import { createEncryptedHealthStore, HEALTH_SECURE_REPORT_LIMIT } from './store.js';

// Explicit disposable environment, not the project's .env or a default local production database.
const TEST_ENV = '/tmp/ernie-health-protection-db.env';
const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL;
const isLocal = (value: string | undefined) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/ernie' &&
      Number(url.port) > 1024
    );
  } catch {
    return false;
  }
};
const ready =
  process.env.ERNIE_HEALTH_PROTECTION_TEST_ENV === TEST_ENV &&
  existsSync(TEST_ENV) &&
  isLocal(APP_URL) &&
  isLocal(OWNER_URL);

const syntheticValue: HealthValue = {
  parameter: 'synthetic_parameter',
  label: 'Parametro sintetico 🧸',
  value: 12.5,
  valueText: '12,5',
  unit: 'unità sintetiche',
  refLow: null,
  refHigh: null,
  refText: 'Riferimento sintetico non interpretabile',
  flag: 'n/d',
};
const values = [syntheticValue];
const input = { takenOn: null, lab: 'Laboratorio sintetico', kind: 'referto sintetico' };
const unavailable = { name: 'HealthProtectionError', code: 'health_data_unavailable' };

describe.skipIf(!ready)(
  'encrypted HealthStore (disposable PostgreSQL, synthetic records only)',
  () => {
    let owner: Pool;
    let app: Pool;
    const users: string[] = [];
    const cipher = createHealthCipher({
      activeKeyId: 'test',
      keys: new Map([['test', Buffer.alloc(32, 37)]]),
    });
    const user = async () => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id,display_name) VALUES ($1,'Synthetic encrypted health')`,
        [id],
      );
      users.push(id);
      return id;
    };
    beforeAll(async () => {
      owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
      app = createPool({ connectionString: APP_URL as string, max: 4 });
      const role = await app.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      );
      expect(role.rows[0]).toEqual({ name: 'ernie_app', rolsuper: false, rolbypassrls: false });
    });
    afterAll(async () => {
      try {
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally {
        cipher.destroy();
        await app?.end();
        await owner?.end();
      }
    });

    it('stores clinical metadata/values only in encrypted payloads; manual reads preserve nulls and Unicode', async () => {
      const account = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const documentId = randomUUID();
      const id = await store.saveReport(account, { ...input, documentId }, values);
      expect(id).toEqual(expect.any(String));
      if (!id) throw new Error('fixture');
      await store.addNotices(account, id, ['Avviso sintetico segreto 🧸']);
      const rows = await owner.query(
        'SELECT row_to_json(r) AS record FROM health_secure_reports r WHERE user_id=$1',
        [account],
      );
      const notices = await owner.query(
        'SELECT row_to_json(n) AS record FROM health_secure_notices n WHERE user_id=$1',
        [account],
      );
      const raw = JSON.stringify([...rows.rows, ...notices.rows]);
      for (const value of [
        input.lab,
        input.kind,
        values[0]?.parameter,
        values[0]?.label,
        values[0]?.refText,
        'Avviso sintetico segreto',
      ])
        expect(raw).not.toContain(value);
      expect(Object.keys(rows.rows[0]?.record).sort()).toEqual([
        'created_at',
        'envelope',
        'id',
        'revision',
        'source_document_id',
        'user_id',
      ]);
      expect(await store.report(account, id)).toEqual({
        id,
        ...input,
        notePath: null,
        values: 1,
        outOfRange: 0,
      });
      expect(await store.reportValues(account, id)).toEqual(values);
      expect(await store.hasDocument(account, documentId)).toBe(true);
      expect(await store.pendingNotices(account)).toMatchObject([
        { text: 'Avviso sintetico segreto 🧸' },
      ]);
    });

    it('preserves dates, created ordering, different units and undated values without inventing a trend', async () => {
      const account = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const old = await store.saveReport(account, { ...input, takenOn: '2026-01-03' }, [
        { ...syntheticValue, value: 10, unit: 'u' },
      ]);
      const unknown = await store.saveReport(account, input, [
        { ...syntheticValue, value: 999, unit: 'u' },
      ]);
      const recent = await store.saveReport(account, { ...input, takenOn: '2026-06-02' }, [
        { ...syntheticValue, value: 11, unit: 'u', refLow: 1, refHigh: 20, flag: 'normale' },
      ]);
      const later = await store.saveReport(account, { ...input, takenOn: '2026-06-02' }, [
        { ...syntheticValue, value: null, valueText: 'qualitativo', unit: null },
      ]);
      await owner.query(
        `UPDATE health_secure_reports SET created_at=CASE WHEN id=$1 THEN '2026-01-01'::timestamptz ELSE '2026-01-02'::timestamptz END WHERE user_id=$2 AND id=ANY($3::uuid[])`,
        [recent, account, [recent, later]],
      );
      expect((await store.reports(account)).map((r) => r.id)).toEqual([
        later,
        recent,
        old,
        unknown,
      ]);
      const series = await store.series(account, 'synthetic_parameter');
      expect(series.map((v) => v.date)).toEqual([null, '2026-01-03', '2026-06-02', '2026-06-02']);
      expect(series.map((v) => v.value)).toEqual([999, 10, 11, null]);
      expect(series[3]).toMatchObject({
        valueText: 'qualitativo',
        unit: null,
        refLow: null,
        refHigh: null,
        flag: 'n/d',
      });
      expect(trendOf(series)).toBe('su');
      expect(await store.parameters(account)).toEqual([
        { parameter: 'synthetic_parameter', label: values[0]?.label, count: 4 },
      ]);
      expect(await store.reports(account, 0)).toEqual([]);
    });

    it('deduplicates concurrent imports of the same account/document without cross-account collisions', async () => {
      const a = await user(),
        b = await user(),
        documentId = randomUUID();
      const store = createEncryptedHealthStore(app, cipher);
      const created = await Promise.all(
        Array.from({ length: 4 }, () => store.saveReport(a, { ...input, documentId }, values)),
      );
      expect(created.filter(Boolean)).toHaveLength(1);
      expect(await store.saveReport(b, { ...input, documentId }, values)).toEqual(
        expect.any(String),
      );
      expect(await store.reports(a)).toHaveLength(1);
      expect(await store.reports(b)).toHaveLength(1);
    });

    it('enforces row-level ownership and never falls back to legacy reports or vault paths', async () => {
      const a = await user(),
        b = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const id = await store.saveReport(a, input, values);
      if (!id) throw new Error('fixture');
      expect(await store.report(b, id)).toBeNull();
      expect(await store.reportValues(b, id)).toEqual([]);
      expect(
        await withUser(app, b, (c) =>
          c.query('SELECT id FROM health_secure_reports WHERE user_id=$1', [a]),
        ),
      ).toMatchObject({ rows: [] });
      await expect(
        withUser(app, b, (c) =>
          c.query(`INSERT INTO health_secure_reports (id,user_id,envelope) VALUES ($1,$2,'{}')`, [
            randomUUID(),
            a,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await owner.query(
        `INSERT INTO health_reports (user_id,taken_on,lab,kind) VALUES ($1,'2020-01-01','Legacy synthetic','legacy')`,
        [b],
      );
      expect(await store.reports(b)).toEqual([]);
      await expect(store.setNotePath(a, id, 'Salute/Synthetic.md')).rejects.toMatchObject(
        unavailable,
      );
      await expect(store.setNotePath(a, id, ' ')).rejects.toMatchObject(unavailable);
      await store.setNotePath(a, id, '');
      expect((await store.report(a, id))?.notePath).toBeNull();
      expect(
        (await owner.query('SELECT 1 FROM brain_notes WHERE user_id=ANY($1::uuid[])', [[a, b]]))
          .rows,
      ).toEqual([]);
    });

    it('rejects swapped ciphertext between records/accounts and altered revision/source bindings', async () => {
      const a = await user(),
        b = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const id1 = await store.saveReport(a, input, values),
        id2 = await store.saveReport(a, input, values);
      const row = (
        await owner.query('SELECT envelope FROM health_secure_reports WHERE id=$1', [id1])
      ).rows[0];
      await owner.query('UPDATE health_secure_reports SET envelope=$1 WHERE id=$2', [
        JSON.stringify(row.envelope),
        id2,
      ]);
      await expect(store.report(a, id2 as string)).rejects.toMatchObject(unavailable);
      await expect(store.reports(a)).rejects.toMatchObject(unavailable);
      await owner.query('UPDATE health_secure_reports SET user_id=$1 WHERE id=$2', [b, id1]);
      await expect(store.report(b, id1 as string)).rejects.toMatchObject(unavailable);
      await owner.query('UPDATE health_secure_reports SET user_id=$1,revision=2 WHERE id=$2', [
        a,
        id1,
      ]);
      await expect(store.report(a, id1 as string)).rejects.toMatchObject(unavailable);
      await owner.query(
        'UPDATE health_secure_reports SET revision=1,source_document_id=$1 WHERE id=$2',
        [randomUUID(), id1],
      );
      await expect(store.report(a, id1 as string)).rejects.toMatchObject(unavailable);
    });

    it('validates authenticated plaintext schema and reports uniform errors without raw clinical/SQL details', async () => {
      const account = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const id = await store.saveReport(account, input, values);
      if (!id) throw new Error('fixture');
      const valid = { schemaVersion: 1, sourceDocumentId: null, ...input, values };
      for (const payload of [
        { ...valid, schemaVersion: 2 },
        { ...valid, takenOn: '2026-02-30' },
        { ...valid, values: [{ ...values[0], refLow: 'clinical secret' }] },
        { ...valid, values: [{ ...values[0], flag: 'diagnosis' }] },
        { ...valid, unrecognized: 'clinical secret' },
      ]) {
        const encrypted = cipher.encrypt(
          { userId: account, resourceKind: 'report', resourceId: id, resourceVersion: 1 },
          Buffer.from(JSON.stringify(payload)),
        );
        await owner.query('UPDATE health_secure_reports SET envelope=$1 WHERE id=$2', [
          JSON.stringify(encrypted),
          id,
        ]);
        await expect(store.report(account, id)).rejects.toMatchObject({
          ...unavailable,
          message: 'I dati protetti non sono disponibili.',
        });
      }
      await expect(
        store.saveReport(account, { ...input, takenOn: '2026-02-30' }, values),
      ).rejects.toBeInstanceOf(HealthProtectionError);
      expect(
        (await owner.query('SELECT 1 FROM health_secure_reports WHERE user_id=$1', [account]))
          .rowCount,
      ).toBe(1);
    });

    it('limits pending notices to 20, marks UUIDs once and supersedes only older report notices', async () => {
      const account = await user();
      const store = createEncryptedHealthStore(app, cipher);
      await store.addNotices(
        account,
        null,
        Array.from({ length: 25 }, (_, i) => `Synthetic notice ${i}`),
      );
      const first = await store.pendingNotices(account);
      expect(first).toHaveLength(20);
      expect(first.every((n) => /^[a-f0-9-]{36}$/.test(n.id))).toBe(true);
      await store.markNotified(
        account,
        first.map((n) => n.id),
      );
      const rest = await store.pendingNotices(account);
      expect(rest).toHaveLength(5);
      await store.markNotified(
        account,
        rest.map((n) => n.id),
      );
      await store.markNotified(
        account,
        first.map((n) => n.id),
      );
      expect(await store.pendingNotices(account)).toEqual([]);
      const old = await store.saveReport(account, input, values),
        current = await store.saveReport(account, input, values);
      await store.addNotices(account, old, ['Older report']);
      await store.addNotices(account, current, ['Current report']);
      await store.addNotices(account, null, ['Summary']);
      await store.supersedeNotices(account, current as string);
      expect((await store.pendingNotices(account)).map((n) => n.text).sort()).toEqual([
        'Current report',
        'Summary',
      ]);
    });

    it('authenticates notices and rejects a notice reassigned to a different report', async () => {
      const account = await user(),
        other = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const a = await store.saveReport(account, input, values),
        b = await store.saveReport(account, input, values);
      await expect(
        store.addNotices(other, a, ['No cross-account association']),
      ).rejects.toMatchObject(unavailable);
      expect(await store.pendingNotices(other)).toEqual([]);
      await store.addNotices(account, a, ['Authenticated relation']);
      await owner.query('UPDATE health_secure_notices SET report_id=$1 WHERE user_id=$2', [
        b,
        account,
      ]);
      await expect(store.pendingNotices(account)).rejects.toMatchObject(unavailable);
    });

    it('never supersedes account notices when the retained report is missing or belongs to another account', async () => {
      const account = await user(),
        other = await user();
      const store = createEncryptedHealthStore(app, cipher);
      const own = await store.saveReport(account, input, values);
      const foreign = await store.saveReport(other, input, values);
      if (!foreign) throw new Error('fixture');
      await store.addNotices(account, own, ['Own notice must survive']);
      const before = await store.pendingNotices(account);
      await expect(store.supersedeNotices(account, randomUUID())).rejects.toMatchObject(
        unavailable,
      );
      await expect(store.supersedeNotices(account, foreign)).rejects.toMatchObject(unavailable);
      expect(await store.pendingNotices(account)).toEqual(before);
    });

    it('rolls back the full notice batch when a later item is invalid', async () => {
      const account = await user();
      const store = createEncryptedHealthStore(app, cipher);
      await expect(
        store.addNotices(account, null, ['Valid first item', 7 as unknown as string]),
      ).rejects.toMatchObject(unavailable);
      expect(await store.pendingNotices(account)).toEqual([]);
    });

    it('checks the write guard in the account transaction before mutations, while manual reads remain available', async () => {
      const account = await user();
      const baseline = createEncryptedHealthStore(app, cipher);
      const id = await baseline.saveReport(account, input, values);
      await baseline.addNotices(account, id, ['Keep pending']);
      const pending = await baseline.pendingNotices(account);
      const guard = vi.fn(async (userId, client) => {
        expect(userId).toBe(account);
        expect(
          (await client.query("SELECT current_setting('app.user_id',true) AS user_id")).rows[0]
            .user_id,
        ).toBe(account);
        throw new Error('synthetic revoked lease containing private details');
      });
      const denied = createEncryptedHealthStore(app, cipher, { guardWrite: guard });
      await expect(denied.saveReport(account, input, values)).rejects.toMatchObject(unavailable);
      await expect(denied.addNotices(account, null, ['No write'])).rejects.toMatchObject(
        unavailable,
      );
      await expect(denied.supersedeNotices(account, randomUUID())).rejects.toMatchObject(
        unavailable,
      );
      await expect(
        denied.markNotified(
          account,
          pending.map((n) => n.id),
        ),
      ).rejects.toMatchObject(unavailable);
      expect(guard).toHaveBeenCalledTimes(4);
      expect(await denied.reports(account)).toHaveLength(1);
      expect(await denied.pendingNotices(account)).toEqual(pending);
      expect(guard).toHaveBeenCalledTimes(4);
    });

    it('integrates the real consent lease: revocation blocks further writes without hiding existing records', async () => {
      const account = await user();
      const consent = createHealthConsentStore(app, async () => true);
      await consent.grant(account, 1, HEALTH_AI_POLICY_VERSION);
      const ticket = await consent.acquire(account);
      const store = createEncryptedHealthStore(app, cipher, {
        guardWrite: (userId, client) => consent.guardWrite(ticket, userId, client),
      });
      const id = await store.saveReport(account, input, values);
      if (!id) throw new Error('fixture');
      await consent.revoke(account);
      await expect(store.saveReport(account, input, values)).rejects.toMatchObject(unavailable);
      expect(await store.reports(account)).toHaveLength(1);
      expect(await store.reportValues(account, id)).toEqual(values);
    });

    it('fails closed before decryption when the archive exceeds its explicit aggregation limit', async () => {
      const account = await user();
      await owner.query(
        `INSERT INTO health_secure_reports (id,user_id,envelope)
      SELECT gen_random_uuid(),$1,'{}'::jsonb FROM generate_series(1,$2)`,
        [account, HEALTH_SECURE_REPORT_LIMIT + 1],
      );
      const decrypt = vi.fn(cipher.decrypt);
      const store = createEncryptedHealthStore(app, { ...cipher, decrypt });
      await expect(store.reports(account)).rejects.toMatchObject(unavailable);
      await expect(store.parameters(account)).rejects.toMatchObject(unavailable);
      await expect(store.series(account, 'synthetic_parameter')).rejects.toMatchObject(unavailable);
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('refuses oversized aggregate payloads in SQL before transferring or decrypting their contents', async () => {
      const account = await user();
      await owner.query(
        `INSERT INTO health_secure_reports (id,user_id,envelope)
         SELECT gen_random_uuid(),$1,jsonb_build_object('padding',repeat('x',1048576)) FROM generate_series(1,65)`,
        [account],
      );
      const decrypt = vi.fn(cipher.decrypt);
      const store = createEncryptedHealthStore(app, { ...cipher, decrypt });
      await expect(store.reports(account)).rejects.toMatchObject(unavailable);
      expect(decrypt).not.toHaveBeenCalled();
    });
  },
);
