import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthConsentStore, HEALTH_AI_POLICY_VERSION } from './consent.js';

const ownerUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
const local =
  process.env.ERNIE_HEALTH_PROTECTION_TEST_ENV === '/tmp/ernie-health-protection-db.env' &&
  existsSync('/tmp/ernie-health-protection-db.env') &&
  ownerUrl &&
  appUrl &&
  [ownerUrl, appUrl].every((raw) => {
    try {
      const u = new URL(raw);
      return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) > 1024;
    } catch {
      return false;
    }
  });

describe.skipIf(!local)('consenso Salute su PostgreSQL isolato', () => {
  let owner: Pool;
  let app: Pool;
  const users: string[] = [];
  const newUser = async () => {
    const id = randomUUID();
    users.push(id);
    await owner.query("INSERT INTO users(id,display_name) VALUES ($1,'Test consenso')", [id]);
    return id;
  };
  beforeAll(() => {
    owner = createPool({ connectionString: ownerUrl as string, max: 2 });
    app = createPool({ connectionString: appUrl as string, max: 8 });
  });
  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await Promise.all([owner.end(), app.end()]);
  });

  it('default negato, consenso esplicito versionato, revoca da dispositivo arretrato e isolamento', async () => {
    const a = await newUser();
    const b = await newUser();
    const store = createHealthConsentStore(app, async () => true);
    expect(await store.get(a)).toMatchObject({ aiAllowed: false, revision: 1, grantedAt: null });
    await expect(store.acquire(a)).rejects.toMatchObject({ code: 'health_consent_required' });
    await expect(store.grant(a, 1, 999)).rejects.toMatchObject({ code: 'health_consent_changed' });
    expect(await store.grant(a, 1, HEALTH_AI_POLICY_VERSION)).toMatchObject({
      aiAllowed: true,
      revision: 2,
    });
    await expect(store.grant(a, 1, HEALTH_AI_POLICY_VERSION)).rejects.toMatchObject({
      code: 'health_consent_changed',
    });
    const ticket = await store.acquire(a);
    await store.check(ticket);
    expect(await store.get(b)).toMatchObject({ aiAllowed: false });
    await expect(withUser(app, b, (c) => store.guardWrite(ticket, b, c))).rejects.toMatchObject({
      code: 'health_consent_changed',
    });
    expect(
      await withUser(app, b, (c) => c.query('SELECT * FROM health_privacy WHERE user_id=$1', [a])),
    ).toMatchObject({ rowCount: 0 });
    const revoked = await store.revoke(a);
    expect(revoked).toMatchObject({ aiAllowed: false, revision: 3 });
    await expect(store.check(ticket)).rejects.toMatchObject({ code: 'health_consent_required' });
    await store.grant(a, revoked.revision, HEALTH_AI_POLICY_VERSION);
    expect(
      (
        await withUser(app, a, (c) =>
          c.query('SELECT action,revision FROM health_consent_events ORDER BY revision'),
        )
      ).rows,
    ).toEqual([
      { action: 'grant', revision: 2 },
      { action: 'revoke', revision: 3 },
      { action: 'grant', revision: 4 },
    ]);
    expect(
      (await withUser(app, b, (c) => c.query('SELECT * FROM health_consent_events'))).rowCount,
    ).toBe(0);
    await expect(
      withUser(app, a, (c) => c.query("UPDATE health_consent_events SET action='grant'")),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withUser(app, a, (c) => c.query('DELETE FROM health_consent_events')),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(store.check(ticket)).rejects.toMatchObject({ code: 'health_consent_changed' });
    await expect(store.acquire(a, ticket.revision)).rejects.toMatchObject({
      code: 'health_consent_changed',
    });
    await expect(store.check({ ...(await store.acquire(a)) })).rejects.toMatchObject({
      code: 'health_consent_changed',
    });
  });

  it('skill spenta, ticket scaduto o cambio policy impediscono nuove richieste', async () => {
    const user = await newUser();
    let enabled = true;
    let now = 1000;
    const store = createHealthConsentStore(app, async () => enabled, {
      now: () => now,
      lifetimeMs: 1000,
    });
    await store.grant(user, 1, HEALTH_AI_POLICY_VERSION);
    const ticket = await store.acquire(user);
    enabled = false;
    await expect(store.check(ticket)).rejects.toMatchObject({ code: 'health_consent_required' });
    await expect(store.acquire(user)).rejects.toMatchObject({ code: 'health_consent_required' });
    enabled = true;
    now = 2000;
    await expect(store.check(ticket)).rejects.toMatchObject({ code: 'health_consent_changed' });
    await owner.query('UPDATE health_privacy SET policy_version=999 WHERE user_id=$1', [user]);
    expect(await store.get(user)).toMatchObject({ aiAllowed: false });
    await expect(store.acquire(user)).rejects.toMatchObject({ code: 'health_consent_required' });
  });

  it('revoca da un secondo processo interrompe il lavoro e non restituisce risultati tardivi', async () => {
    const user = await newUser();
    const store = createHealthConsentStore(app, async () => true, { pollMs: 50 });
    const anotherProcess = createHealthConsentStore(app, async () => true);
    await store.grant(user, 1, HEALTH_AI_POLICY_VERSION);
    const ticket = await store.acquire(user);
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const work = store.run(ticket, async (signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      return finish.promise;
    });
    const rejected = expect(work).rejects.toMatchObject({ code: 'health_consent_required' });
    await started.promise;
    await anotherProcess.revoke(user);
    await aborted.promise;
    finish.resolve('RISULTATO SANITARIO SINTETICO DA NON RESTITUIRE');
    await rejected;
    await expect(
      withUser(app, user, async (c) => {
        await store.guardWrite(ticket, user, c);
        await c.query("UPDATE users SET display_name='Non deve succedere' WHERE id=$1", [user]);
      }),
    ).rejects.toMatchObject({ code: 'health_consent_required' });
    expect(
      (await owner.query('SELECT display_name FROM users WHERE id=$1', [user])).rows[0]
        .display_name,
    ).toBe('Test consenso');
  });

  it('autorizzazione e scrittura sono atomiche rispetto alla revoca', async () => {
    const user = await newUser();
    const store = createHealthConsentStore(app, async () => true);
    await store.grant(user, 1, HEALTH_AI_POLICY_VERSION);
    const ticket = await store.acquire(user);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = withUser(app, user, async (c) => {
      await store.guardWrite(ticket, user, c);
      locked.resolve();
      await release.promise;
      // Same transaction as the hypothetical encrypted result write.
      const row = await c.query('SELECT ai_allowed FROM health_privacy WHERE user_id=$1', [user]);
      expect(row.rows[0].ai_allowed).toBe(true);
    });
    await locked.promise;
    const revoke = store.revoke(user);
    release.resolve();
    await write;
    expect(await revoke).toMatchObject({ aiAllowed: false });
    await expect(store.check(ticket)).rejects.toMatchObject({ code: 'health_consent_required' });
  });
  it('controlla la skill nella stessa connessione anche con un pool di una sola connessione', async () => {
    const user = await newUser();
    const single = createPool({ connectionString: appUrl as string, max: 1 });
    try {
      const store = createHealthConsentStore(
        single,
        async (id, c) => (await c.query('SELECT id FROM users WHERE id=$1', [id])).rowCount === 1,
      );
      await store.grant(user, 1, HEALTH_AI_POLICY_VERSION);
      const ticket = await store.acquire(user);
      await withUser(single, user, (c) => store.guardWrite(ticket, user, c));
      expect(await store.run(ticket, async () => 'ok')).toBe('ok');
    } finally {
      await single.end();
    }
  });
  it('rivalida la scadenza dopo un controllo permessi lento prima di autorizzare la scrittura', async () => {
    const user = await newUser();
    let now = 1000;
    let pause = false;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const store = createHealthConsentStore(
      app,
      async () => {
        if (pause) {
          entered.resolve();
          await resume.promise;
        }
        return true;
      },
      { now: () => now, lifetimeMs: 1000 },
    );
    await store.grant(user, 1, HEALTH_AI_POLICY_VERSION);
    const ticket = await store.acquire(user);
    pause = true;
    const pending = withUser(app, user, async (c) => {
      await store.guardWrite(ticket, user, c);
      await c.query("UPDATE users SET display_name='Scaduto' WHERE id=$1", [user]);
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'health_consent_changed' });
    await entered.promise;
    now = 2001;
    resume.resolve();
    await rejected;
    expect(
      (await owner.query('SELECT display_name FROM users WHERE id=$1', [user])).rows[0]
        .display_name,
    ).toBe('Test consenso');
  });
});
