import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consolidateThread, type Extractor } from './consolidate.js';
import { createFakeEmbedder } from './embeddings.js';
import { recordTurnEpisode } from './episodes.js';
import { applyWithJudge, type Judge } from './judge.js';
import { createMemoryRepository } from './repository.js';
import { buildMemorySnapshot } from './snapshot.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

function appUrl(ownerUrl: string, password: string): string {
  const u = new URL(ownerUrl);
  u.username = 'ernie_app';
  u.password = password;
  return u.toString();
}

describe.skipIf(!ready)('Memory Engine su Postgres (ruolo ernie_app, embedder finto)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  const logger = createLogger({ level: 'silent', name: 't' });
  const repo = () => createMemoryRepository(app, createFakeEmbedder(1536), { logger });

  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    app = createPool({
      connectionString: appUrl(OWNER_URL as string, APP_PASSWORD as string),
      max: 3,
    });
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

  it('ricorda, deduplica (esatto e semantico) e supersede le contraddizioni', async () => {
    const r = repo();
    const a = await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'habit',
      content: 'Compra il latte ogni settimana',
      provenance: { source: 'user', trust: 1 },
      confidence: 0.8,
    });
    expect(a.deduplicated).toBe(false);
    expect(a.embedded).toBe(true);
    const again = await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'habit',
      content: '  compra IL latte ogni settimana ',
      provenance: { source: 'user', trust: 1 },
      confidence: 0.9,
    });
    expect(again.deduplicated).toBe(true);
    expect(again.record.id).toBe(a.record.id);
    expect(again.record.seenCount).toBe(2);
    expect(again.record.confidence).toBeCloseTo(0.9);
    const near = await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'habit',
      content: 'Compra il latte ogni settimana!',
      provenance: { source: 'user', trust: 1 },
    });
    expect(near.deduplicated).toBe(true);

    const old = await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'fact',
      content: 'Vive a Padova',
      provenance: { source: 'user', trust: 1 },
    });
    const neu = await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'fact',
      content: 'Vive a Mestre dal 2026',
      provenance: { source: 'user', trust: 1 },
      supersedesId: old.record.id,
    });
    expect(neu.superseded).toBe(true);
    const oldNow = await r.getById(userA, old.record.id);
    expect(oldNow?.status).toBe('superseded');
    expect(oldNow?.validTo).not.toBeNull();
    const active = await r.listActiveSemantic(userA);
    expect(active.map((m) => m.content)).toContain('Vive a Mestre dal 2026');
    expect(active.map((m) => m.content)).not.toContain('Vive a Padova');
  });

  it("ricerca ibrida: full-text e vettori fusi con RRF, solo ricordi attivi dell'utente", async () => {
    const r = repo();
    await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'preference',
      content: 'Non vuole ricette con i funghi',
      provenance: { source: 'user', trust: 1 },
    });
    await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'relationship',
      content: 'Suo figlio si chiama Leo',
      provenance: { source: 'user', trust: 1 },
    });
    await r.remember({
      userId: userB,
      kind: 'semantic',
      category: 'preference',
      content: 'Adora i funghi porcini',
      provenance: { source: 'user', trust: 1 },
    });
    const hits = await r.search({ userId: userA, query: 'funghi nelle ricette', limit: 3 });
    expect(hits[0]?.content).toBe('Non vuole ricette con i funghi');
    expect(hits.some((h) => h.content.includes('porcini'))).toBe(false);
    expect(hits[0]?.ftsRank ?? hits[0]?.vecRank).not.toBeNull();
    const kid = await r.search({ userId: userA, query: 'come si chiama il figlio', limit: 2 });
    expect(kid.map((h) => h.content)).toContain('Suo figlio si chiama Leo');
    const episodic = await r.search({ userId: userA, query: 'funghi', kinds: ['episodic'] });
    expect(episodic).toHaveLength(0);
  });

  it('episodi deterministici, snapshot, export, oblio e purge', async () => {
    const r = repo();
    await recordTurnEpisode(r, {
      userId: userA,
      sessionId: randomUUID(),
      requestId: 'r1',
      userText: 'cosa cucino stasera',
      route: 'llm',
      modelClass: 'standard',
      model: 'm',
      outcome: 'completed',
      costUsd: 0.002,
      llmCalls: 1,
      toolCalls: 0,
      latencyMs: 3200,
    });
    const ep = await r.search({
      userId: userA,
      query: 'cucino stasera',
      kinds: ['episodic'],
      limit: 1,
    });
    expect(ep[0]?.content).toContain('Turno completato');
    expect(ep[0]?.provenance.source).toBe('system');

    const snap = buildMemorySnapshot(await r.listActiveSemantic(userA));
    expect(snap.text).toContain('Vive a Mestre dal 2026');
    expect(snap.text).not.toContain('Turno completato');

    const exported = await r.exportAll(userA);
    expect(exported.length).toBeGreaterThanOrEqual(5);
    const target = exported.find((m) => m.content.includes('Leo'));
    expect(target).toBeDefined();
    expect(await r.forget(userA, (target as { id: string }).id)).toBe(true);
    expect(
      (await r.search({ userId: userA, query: 'figlio Leo' })).some((h) =>
        h.content.includes('Leo'),
      ),
    ).toBe(false);
    expect(await r.purge(owner, 0)).toBeGreaterThanOrEqual(0);
    expect(await r.forgetAll(userB)).toBeGreaterThanOrEqual(1);
  });

  it('consolidamento con estrattore sostitutivo: cursore, inserimento e supersessione', async () => {
    const r = repo();
    await r.remember({
      userId: userA,
      kind: 'semantic',
      category: 'fact',
      content: 'Vive a Mestre dal 2026',
      provenance: { source: 'user', trust: 1 },
    });
    const threadId = `t-${randomUUID()}`;
    const now = Date.now();
    const threads = {
      async recall() {
        return {
          messages: [
            {
              role: 'user',
              content: 'Da oggi vivo a Venezia, non più a Mestre',
              createdAt: new Date(now - 2000),
            },
            { role: 'assistant', content: 'Segnato!', createdAt: new Date(now - 1000) },
          ],
        };
      },
    };
    const extractor: Extractor = async () => ({
      facts: [
        {
          content: 'Vive a Venezia dal 2026',
          category: 'fact',
          confidence: 0.9,
          retention: 'permanent',
          kind: 'state',
          validFrom: null,
          validTo: null,
        },
      ],
    });
    // Giudice finto: il ricordo su Mestre (unico candidato vicino) è smentito con evidenza esplicita.
    const judge: Judge = async (input) => ({
      decisions: input.facts.flatMap((f, i) =>
        f.candidates.map((c, j) => ({
          fact: i,
          candidate: j,
          reasoning: 'cambio di residenza dichiarato',
          relation: c.text.includes('Mestre') ? ('contradicts' as const) : ('compatible' as const),
          evidence: 'non più a Mestre',
          confidence: 0.9,
        })),
      ),
    });
    const deps = {
      pool: app,
      repo: r,
      threads,
      gateway: null as never,
      recorder: { record: async () => {} },
      logger,
      extractor,
      judge,
    };
    const first = await consolidateThread(deps, { userId: userA, threadId, sessionId: null });
    expect(first).toMatchObject({
      skipped: false,
      read: 2,
      extracted: 1,
      inserted: 1,
      superseded: 1,
    });
    const active = await r.listActiveSemantic(userA);
    expect(active.map((m) => m.content)).toContain('Vive a Venezia dal 2026');
    expect(active.map((m) => m.content)).not.toContain('Vive a Mestre dal 2026');
    const second = await consolidateThread(deps, { userId: userA, threadId, sessionId: null });
    expect(second.skipped).toBe(true);
    // L'avviso «ho aggiornato…» è in attesa una sola volta.
    const notices = await r.pendingNotices(userA);
    expect(notices).toMatchObject([
      {
        event: 'superseded',
        oldText: 'Vive a Mestre dal 2026',
        newText: 'Vive a Venezia dal 2026',
      },
    ]);
    await r.markNotified(
      userA,
      notices.map((n) => n.id),
    );
    expect(await r.pendingNotices(userA)).toEqual([]);
  });

  it('giudice: prove deboli → entrambi in dubbio; fatto effimero → scade da solo', async () => {
    const r = repo();
    const user = userB;
    await r.remember({
      userId: user,
      kind: 'semantic',
      category: 'preference',
      content: 'Preferisce il tè la mattina',
      provenance: { source: 'user', trust: 1 },
      confidence: 0.9,
    });
    const weak: Judge = async (input) => ({
      decisions: input.facts.flatMap((f, i) =>
        f.candidates.map((_c, j) => ({
          fact: i,
          candidate: j,
          reasoning: 'forse ha cambiato abitudine, ma non lo dice',
          relation: 'contradicts' as const,
          evidence: '',
          confidence: 0.5,
        })),
      ),
    });
    const today = new Date('2026-10-13T08:00:00Z');
    const stats = await applyWithJudge(
      { repo: r, judge: weak },
      user,
      [
        {
          content: 'Preferisce il caffè la mattina',
          category: 'preference',
          confidence: 0.6,
          retention: 'durable',
          temporalKind: 'state',
          validFrom: today,
          validTo: null,
        },
        {
          content: 'Ha la verifica di storia oggi',
          category: 'fact',
          confidence: 0.9,
          retention: 'ephemeral',
          temporalKind: 'event',
          // già passata: deve uscire dai ricordi validi
          validFrom: new Date('2026-10-01T00:00:00Z'),
          validTo: new Date('2026-10-02T00:00:00Z'),
        },
      ],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(stats).toMatchObject({ inserted: 2, disputed: 1, superseded: 0 });
    const live = await r.listActiveSemantic(user);
    const tea = live.find((m) => m.content.includes('tè'));
    const coffee = live.find((m) => m.content.includes('caffè'));
    expect(tea?.status).toBe('disputed');
    expect(coffee?.status).toBe('disputed');
    expect(tea?.conflictGroup).toBe(coffee?.conflictGroup);
    expect(live.some((m) => m.content.includes('verifica'))).toBe(false);
    expect((await r.pendingNotices(user)).map((n) => n.event)).toEqual(['disputed']);
  });
});
