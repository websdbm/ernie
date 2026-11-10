import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createPool, type Pool } from '@ernie/db';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { healthVaultRoutes } from '../routes/health-vault.js';
import { createHealthCipher } from './crypto.js';
import { createHealthVaultService } from './service.js';

const ownerUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
const local =
  process.env.ERNIE_HEALTH_PROTECTION_TEST_ENV === '/tmp/ernie-health-protection-db.env' &&
  existsSync('/tmp/ernie-health-protection-db.env') &&
  [ownerUrl, appUrl].every((s) => {
    if (!s) return false;
    const u = new URL(s);
    return (
      ['127.0.0.1', 'localhost'].includes(u.hostname) &&
      Number(u.port) > 1024 &&
      u.pathname === '/ernie'
    );
  });
const extraction = {
  isLabReport: true,
  takenOn: null,
  lab: 'Laboratorio sintetico',
  kind: 'analisi',
  items: [{ name: 'Glicemia', value: '90', unit: 'mg/dL', ref: '70 - 110' }],
};
const source = () => ({
  id: randomUUID(),
  title: 'Referto sintetico privato',
  source: 'text',
  pages: ['Glicemia 90 mg/dL, riferimento 70 - 110'],
});

describe.skipIf(!local)('Salute runtime + HTTP (isolated PostgreSQL, no provider)', () => {
  let owner: Pool;
  let app: Pool;
  const users: string[] = [];
  const cipher = createHealthCipher({
    activeKeyId: 'fixture',
    keys: new Map([['fixture', Buffer.alloc(32, 99)]]),
  });
  const user = async (enabled = true) => {
    const id = randomUUID();
    users.push(id);
    await owner.query('INSERT INTO users(id,display_name,settings) VALUES($1,$2,$3)', [
      id,
      'Synthetic health HTTP',
      { skills: { salute: enabled } },
    ]);
    return id;
  };
  const setup = (overrides: Partial<Parameters<typeof createHealthVaultService>[0]> = {}) =>
    createHealthVaultService({
      pool: app,
      cipher,
      extractor: vi.fn(async () => extraction),
      answerer: vi.fn(async () => ({ answer: 'Risposta sintetica', model: 'fixture' })),
      checkBudget: vi.fn(async () => {}),
      ...overrides,
    });
  beforeAll(() => {
    owner = createPool({ connectionString: ownerUrl as string });
    app = createPool({ connectionString: appUrl as string, max: 8 });
  });
  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await Promise.all([owner.end(), app.end()]);
    cipher.destroy();
  });
  it('manual archive with AI and skill off; cross-account isolation; default denial', async () => {
    const a = await user(false),
      b = await user();
    const vault = setup();
    const input = source();
    expect(await vault.capabilities(a)).toMatchObject({
      encryptionReady: true,
      skillEnabled: false,
      consent: { aiAllowed: false },
      migration: { state: 'ready' },
    });
    await vault.upload(a, input);
    expect((await vault.sources(a)).length).toBe(1);
    expect(await vault.sources(b)).toEqual([]);
    await expect(vault.source(b, input.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(vault.analyze(a, input.id)).rejects.toMatchObject({
      code: 'health_consent_required',
    });
    expect(
      Buffer.from((await vault.export(a, { sourceId: input.id })).dataBase64, 'base64').toString(),
    ).toContain(input.pages[0]);
    const raw = await owner.query(
      'SELECT row_to_json(s)::text AS raw FROM health_secure_sources s WHERE user_id=$1',
      [a],
    );
    expect(JSON.stringify(raw.rows)).not.toContain(input.title);
    expect(JSON.stringify(raw.rows)).not.toContain(input.pages[0]);
  });
  it('consent gates AI; retry avoids double call; no ordinary storage; manual read after revoke', async () => {
    const a = await user();
    const extract = vi.fn(async () => extraction);
    const vault = setup({ extractor: extract });
    const s = source();
    await vault.upload(a, s);
    await vault.consent.grant(a, 1, 1);
    const result = await vault.analyze(a, s.id);
    expect(result.values).toBe(1);
    expect(await vault.analyze(a, s.id)).toEqual(result);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await vault.report(a, result.reportId)).toMatchObject({
      takenOn: null,
      againstDate: null,
      rows: [{ value: 90 }],
    });
    await vault.consent.revoke(a);
    expect((await vault.report(a, result.reportId)).rows.length).toBe(1);
    await expect(vault.ask(a, { question: 'Riassumi' })).rejects.toMatchObject({
      code: 'health_consent_required',
    });
    for (const table of [
      'health_reports',
      'health_values',
      'health_notices',
      'documents',
      'brain_notes',
      'tool_calls',
    ])
      expect(
        (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [a])).rows[0]
          .n,
      ).toBe(0);
  });
  it('revocation while provider runs discards result, regrant does not revive it', async () => {
    const a = await user();
    let release: (x: typeof extraction) => void = () => {};
    let started: () => void = () => {};
    const reached = new Promise<void>((r) => {
      started = r;
    });
    const vault = setup({
      extractor: async () => {
        started();
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const s = source();
    await vault.upload(a, s);
    await vault.consent.grant(a, 1, 1);
    const running = vault.analyze(a, s.id);
    const rejected = expect(running).rejects.toBeDefined();
    await reached;
    const state = await vault.consent.revoke(a);
    await vault.consent.grant(a, state.revision, 1);
    release(extraction);
    await rejected;
    expect(await vault.reports(a)).toEqual([]);
  });
  it('deleting a source during analysis never recreates source or report', async () => {
    const a = await user();
    let release: (x: typeof extraction) => void = () => {};
    let started: () => void = () => {};
    const reached = new Promise<void>((r) => {
      started = r;
    });
    const vault = setup({
      extractor: async () => {
        started();
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const s = source();
    await vault.upload(a, s);
    await vault.consent.grant(a, 1, 1);
    const pending = vault.analyze(a, s.id);
    const rejected = expect(pending).rejects.toBeDefined();
    await reached;
    await vault.remove(a, s.id);
    release(extraction);
    await rejected;
    expect(await vault.reports(a)).toEqual([]);
  });
  it('in-flight answer is discarded after source deletion; no result history', async () => {
    const a = await user();
    let release: (x: { answer: string; model: string }) => void = () => {};
    let started: () => void = () => {};
    const reached = new Promise<void>((r) => {
      started = r;
    });
    const vault = setup({
      answerer: async () => {
        started();
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const s = source();
    await vault.upload(a, s);
    await vault.consent.grant(a, 1, 1);
    const pending = vault.ask(a, { question: 'Riassumi', sourceIds: [s.id] });
    const rejected = expect(pending).rejects.toBeDefined();
    await reached;
    await vault.remove(a, s.id);
    release({ answer: 'Private late answer', model: 'fixture' });
    await rejected;
  });
  it('rejects legacy pending migration and missing keys without falling back to plaintext', async () => {
    const a = await user();
    await owner.query("INSERT INTO health_reports(user_id,kind) VALUES($1,'legacy')", [a]);
    const vault = setup();
    expect((await vault.capabilities(a)).migration.state).toBe('pending');
    await expect(vault.sources(a)).rejects.toMatchObject({ code: 'health_migration_pending' });
    const unavailable = setup({ cipher: null });
    await expect(unavailable.upload(a, source())).rejects.toMatchObject({ statusCode: 503 });
    expect((await unavailable.consent.revoke(a)).aiAllowed).toBe(false);
  });
  it('explicit source selection excludes unrelated reports and respects budget before provider', async () => {
    const a = await user();
    const answerer = vi.fn(async () => ({ answer: 'Synthetic', model: 'fixture' }));
    const checkBudget = vi.fn(async () => {});
    const vault = setup({ answerer, checkBudget });
    const first = source(),
      second = { ...source(), title: 'Solo questo documento' };
    await vault.upload(a, first);
    await vault.upload(a, second);
    await vault.consent.grant(a, 1, 1);
    await vault.analyze(a, first.id);
    const result = await vault.ask(a, { question: 'Riassumi', sourceIds: [second.id] });
    expect(result.sources).toEqual([{ id: second.id, title: second.title }]);
    expect(answerer.mock.calls[0]).toBeDefined();
    const denied = setup({
      answerer,
      checkBudget: async () => {
        throw new Error('budget');
      },
    });
    await expect(denied.ask(a, { question: 'Riassumi' })).rejects.toThrow();
    expect(answerer).toHaveBeenCalledTimes(1);
  });
  it('HTTP scopes, no-store, own-account routes, sanitized errors and strict consent', async () => {
    const a = await user(),
      b = await user();
    const vault = setup();
    const api = Fastify();
    await api.register(healthVaultRoutes, {
      allowedOrigins: [],
      service: vault,
      authenticator: {
        authenticate: async (token) =>
          token
            ? {
                userId: token === 'b' ? b : a,
                apiKeyId: randomUUID(),
                scopes: token === 'noscope' ? [] : ['chat'],
                role: 'owner',
                companionName: 'Ernie',
                settings: {},
              }
            : null,
      },
    });
    try {
      expect((await api.inject({ url: '/v1/health/sources' })).statusCode).toBe(401);
      expect(
        (
          await api.inject({
            url: '/v1/health/sources',
            headers: { authorization: 'Bearer noscope' },
          })
        ).statusCode,
      ).toBe(403);
      const input = source();
      const saved = await api.inject({
        method: 'POST',
        url: '/v1/health/sources',
        headers: { authorization: 'Bearer a' },
        payload: input,
      });
      expect(saved.statusCode).toBe(201);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(
        (
          await api.inject({
            url: `/v1/health/sources/${input.id}`,
            headers: { authorization: 'Bearer b' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/v1/health/consent',
            headers: { authorization: 'Bearer a' },
            payload: { allowed: true },
          })
        ).statusCode,
      ).toBe(400);
      const bad = await api.inject({
        method: 'POST',
        url: '/v1/health/sources',
        headers: { authorization: 'Bearer a' },
        payload: { ...input, id: 'PATIENT_PRIVATE_MARKER' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('PATIENT_PRIVATE_MARKER');
    } finally {
      await api.close();
    }
  });
});
