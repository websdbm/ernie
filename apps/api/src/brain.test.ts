import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainServiceOptions } from '@ernie/brain';
import { loadConfig } from '@ernie/config';
import type { Pool } from '@ernie/db';
import type { ProfileStore } from '@ernie/memory';
import { createLogger } from '@ernie/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  onNotesWritten: undefined as BrainServiceOptions['onNotesWritten'],
  service: {
    identities: vi.fn(),
    consolidateDuplicates: vi.fn(),
    read: vi.fn(),
    merge: vi.fn(),
    syncAll: vi.fn(),
    writeChiSono: vi.fn(),
    reviewSnapshot: vi.fn(),
    reconcile: vi.fn(),
  },
}));
vi.mock('@ernie/brain', async (original) => ({
  ...(await original<object>()),
  createBrainIndex: vi.fn(),
  createBrainService: (options: BrainServiceOptions) => {
    mocks.onNotesWritten = options.onNotesWritten;
    return mocks.service;
  },
}));

import { createBrainRuntime } from './brain.js';

const user = '11111111-2222-3333-4444-555555555555';
const dirs: string[] = [];
const source = {
  path: 'Luoghi/Casa.md',
  title: 'Casa della compagna',
  type: 'luogo',
  body: 'Via Roma 12.',
  place: null,
  created: '2026-10-17',
};
const target = {
  ...source,
  path: 'Persone/Anna.md',
  title: 'Anna',
  type: 'persona',
  body: 'Compagna.',
};
const plan = {
  connections: [{ source: source.path, target: target.path, quote: source.body }],
  questions: [],
};
async function setup(options: { allowed?: boolean; budget?: boolean; interval?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ernie-review-runtime-'));
  dirs.push(dir);
  await mkdir(join(dir, user));
  mocks.service.identities.mockReset().mockResolvedValue([]);
  mocks.service.consolidateDuplicates.mockReset().mockResolvedValue(0);
  mocks.service.read.mockReset().mockResolvedValue(null);
  mocks.service.merge.mockReset().mockResolvedValue({ title: 'Anna Rossi', merged: ['Anna'] });
  mocks.service.syncAll.mockReset().mockResolvedValue([]);
  mocks.service.writeChiSono.mockReset().mockResolvedValue(undefined);
  mocks.service.reviewSnapshot
    .mockReset()
    .mockResolvedValue({ fingerprint: 'one', notes: [source, target] });
  mocks.service.reconcile
    .mockReset()
    .mockResolvedValue({ changed: 0, questions: [], stale: false });
  const reviewer = vi.fn().mockResolvedValue(plan);
  const checkBudget = vi.fn(async () => {
    if (options.budget === false) throw new Error('budget');
  });
  const deps = {
    config: loadConfig({
      DATABASE_URL: 'postgres://test:test@localhost/test',
      REDIS_URL: 'redis://localhost',
      BRAIN_DIR: dir,
      BRAIN_REVIEW_INTERVAL_S: String(options.interval ?? 86400),
    }),
    pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool,
    profiles: {
      get: vi.fn().mockResolvedValue({ family: [], places: [] }),
      consolidateFamily: vi.fn().mockResolvedValue({ changed: false, question: null }),
    } as unknown as ProfileStore,
    embedder: null,
    logger: createLogger({ name: 'brain-test', level: 'silent' }),
    reviewer,
    mayReconcile: async () => options.allowed !== false,
    checkBudget,
  };
  return { runtime: await createBrainRuntime(deps), deps, reviewer, checkBudget };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
describe('manutenzione periodica del Second Brain', () => {
  it('consolida aggiunte locali senza modello o modifica del limite giornaliero', async () => {
    const { runtime, deps, reviewer } = await setup();
    await runtime.runMaintenance();
    const path = join(deps.config.brain.dir, '.review', `${user}.json`);
    const { readFile } = await import('node:fs/promises');
    const before = await readFile(path, 'utf8');
    reviewer.mockClear();
    mocks.service.reconcile.mockClear();
    await mocks.onNotesWritten?.(user, [source.path]);
    expect(mocks.service.reconcile).toHaveBeenCalledWith(
      user,
      { connections: [], questions: [] },
      undefined,
      [source.path],
    );
    expect(reviewer).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(before);
    await runtime.runMaintenance();
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('il consolidamento locale rispetta disattivazione e autorizzazioni', async () => {
    for (const options of [{ allowed: false }, { interval: 0 }]) {
      const { reviewer } = await setup(options);
      await mocks.onNotesWritten?.(user, [source.path]);
      expect(mocks.service.reconcile).not.toHaveBeenCalled();
      expect(reviewer).not.toHaveBeenCalled();
    }
  });

  it('riallinea il profilo prima di rigenerare le schede e riprende dopo un errore SQL', async () => {
    const { runtime, deps } = await setup();
    mocks.service.identities.mockResolvedValue([
      {
        title: 'Anna Rossi',
        path: 'Persone/Anna Rossi.md',
        type: 'persona',
        aliases: [{ title: 'Anna', path: 'Persone/Anna.md' }],
      },
    ]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(deps.profiles.consolidateFamily).mockRejectedValueOnce(new Error('SQL unavailable'));
    await runtime.runMaintenance();
    expect(mocks.service.writeChiSono).not.toHaveBeenCalled();
    await runtime.runMaintenance();
    expect(deps.profiles.consolidateFamily).toHaveBeenCalledOnce();
    now += 86_400_001;
    await runtime.runMaintenance();
    expect(deps.profiles.consolidateFamily).toHaveBeenLastCalledWith(user, 'Anna Rossi', ['Anna']);
    expect(mocks.service.writeChiSono).toHaveBeenCalledOnce();
    const headOrder = vi.mocked(deps.profiles.consolidateFamily).mock.invocationCallOrder[1] ?? 0;
    expect(headOrder).toBeLessThan(mocks.service.writeChiSono.mock.invocationCallOrder[0] ?? 0);
  });
  it('limita il battito a una passata ogni cinque minuti e conserva i dubbi anagrafici', async () => {
    const { runtime, deps } = await setup();
    mocks.service.identities.mockResolvedValue([
      {
        title: 'Anna Rossi',
        path: 'Persone/Anna Rossi.md',
        type: 'persona',
        aliases: [{ title: 'Anna', path: 'Persone/Anna.md' }],
      },
    ]);
    vi.mocked(deps.profiles.consolidateFamily).mockResolvedValue({
      changed: false,
      question: 'Quale data di nascita è corretta?',
    });
    await runtime.heartbeat();
    await runtime.heartbeat();
    expect(mocks.service.syncAll).toHaveBeenCalledOnce();
    expect(await runtime.pendingReview(user)).toBe('Quale data di nascita è corretta?');
  });
  it('il tool registra la fusione e riallinea subito il profilo', async () => {
    const { runtime, deps } = await setup();
    mocks.service.identities.mockResolvedValue([
      {
        title: 'Anna Rossi',
        path: 'Persone/Anna Rossi.md',
        type: 'persona',
        aliases: [{ title: 'Anna', path: 'Persone/Anna.md' }],
      },
    ]);
    await runtime.tools.merge(user, { into: 'Anna Rossi', notes: ['Anna'] });
    expect(mocks.service.merge).toHaveBeenCalledOnce();
    expect(deps.profiles.consolidateFamily).toHaveBeenCalledOnce();
    expect(mocks.service.writeChiSono).toHaveBeenCalledOnce();
  });

  it('non ritenta una revisione fallita prima di 24 ore, nemmeno con un intervallo inferiore', async () => {
    const { runtime, reviewer } = await setup({ interval: 1800 });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    reviewer.mockRejectedValue(new Error('network'));
    await runtime.runMaintenance();
    now += 301_000;
    await runtime.runMaintenance();
    now += 301_000;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    now += 301_000;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    now += 86_400_000;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledTimes(2);
  });
  it('non spende altre chiamate giornaliere su un vault già esaminato e invariato', async () => {
    const { runtime, reviewer } = await setup({ interval: 1800 });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await runtime.runMaintenance();
    now += 1_801_000;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    now += 86_400_000;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    mocks.service.reviewSnapshot.mockResolvedValue({
      fingerprint: 'changed',
      notes: [source, { ...target, body: 'Compagna, nuova informazione.' }],
    });
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    now += 86_400_000;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('rispetta la passata del vecchio formato e le modifiche nuove non aggirano il limite', async () => {
    const { runtime, deps, reviewer } = await setup({ interval: 1 });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await mkdir(join(deps.config.brain.dir, '.review'));
    await writeFile(
      join(deps.config.brain.dir, '.review', `${user}.json`),
      JSON.stringify({
        attemptedAt: now - 60_000,
        completedAt: now - 30_000,
        fingerprint: 'older',
        cursor: 0,
        versions: {},
        questionsFingerprint: '',
        plan: { connections: [], questions: [] },
        questions: [],
      }),
    );
    await runtime.runMaintenance();
    expect(reviewer).not.toHaveBeenCalled();
    expect(mocks.service.writeChiSono).not.toHaveBeenCalled();
    expect(mocks.service.consolidateDuplicates).not.toHaveBeenCalled();
    now += 86_400_001;
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    mocks.service.reviewSnapshot.mockResolvedValue({
      fingerprint: 'new data',
      notes: [source, target],
    });
    now += 3_600_000;
    const restarted = await createBrainRuntime(deps);
    await restarted.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    expect(mocks.service.reconcile).toHaveBeenCalledOnce();
  });

  it('include i vault locali senza remoto, sincronizza prima e non richiama il modello dopo un riavvio', async () => {
    const { runtime, deps, reviewer } = await setup();
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    expect(mocks.service.syncAll.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.service.writeChiSono.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.service.reconcile).toHaveBeenLastCalledWith(user, plan, 'one');
    const restarted = await createBrainRuntime(deps);
    await restarted.runMaintenance();
    expect(reviewer).toHaveBeenCalledOnce();
    expect(mocks.service.reconcile).toHaveBeenCalledOnce();
    expect(mocks.service.writeChiSono).toHaveBeenCalledOnce();
    expect(mocks.service.consolidateDuplicates).toHaveBeenCalledOnce();
  });
  it('rispetta budget, interruttore e disattivazione; non ripete subito una chiamata fallita', async () => {
    const limited = await setup({ budget: false });
    await limited.runtime.runMaintenance();
    await limited.runtime.runMaintenance();
    expect(limited.checkBudget).toHaveBeenCalledOnce();
    expect(limited.reviewer).not.toHaveBeenCalled();
    expect(mocks.service.reconcile).toHaveBeenCalledOnce();
    const disabled = await setup({ allowed: false });
    await disabled.runtime.runMaintenance();
    expect(disabled.reviewer).not.toHaveBeenCalled();
    expect(mocks.service.writeChiSono).not.toHaveBeenCalled();
    expect(mocks.service.reconcile).not.toHaveBeenCalled();
    const off = await setup({ interval: 0 });
    await off.runtime.runMaintenance();
    expect(off.reviewer).not.toHaveBeenCalled();
    expect(mocks.service.reconcile).not.toHaveBeenCalled();
  });
  it('scarta un collegamento semantico se cambia la persona, anche quando la citazione è invariata', async () => {
    const { runtime, reviewer } = await setup();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await runtime.runMaintenance();
    now += 86_400_001;
    reviewer.mockResolvedValue(null);
    mocks.service.reviewSnapshot.mockResolvedValue({
      fingerprint: 'two',
      notes: [source, { ...target, body: 'Omonima, collega.' }],
    });
    await runtime.runMaintenance();
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(mocks.service.reconcile).toHaveBeenLastCalledWith(
      user,
      { connections: [], questions: [] },
      'two',
    );
  });
  it('presenta i dubbi solo finché sono attuali e non sovrappone due passate', async () => {
    const { runtime, reviewer } = await setup();
    mocks.service.reconcile.mockResolvedValue({
      changed: 0,
      questions: ['Quale indirizzo è attuale?'],
      stale: false,
    });
    await Promise.all([runtime.runMaintenance(), runtime.runMaintenance()]);
    expect(reviewer).toHaveBeenCalledOnce();
    expect(await runtime.pendingReview(user)).toBe('Quale indirizzo è attuale?');
    mocks.service.reviewSnapshot.mockResolvedValue({
      fingerprint: 'changed',
      notes: [source, target],
    });
    expect(await runtime.pendingReview(user)).toBeNull();
  });
});
