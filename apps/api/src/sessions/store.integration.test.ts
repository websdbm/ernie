import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createBudgetGuard, createLlmCallRecorder } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import { createEvent } from '@ernie/protocol';
import { createSoulRepository } from '@ernie/soul';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionStore, SessionForbiddenError } from './store.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const REDIS_URL = process.env.REDIS_URL;
const ready = Boolean(OWNER_URL && APP_PASSWORD && REDIS_URL);

function appUrl(ownerUrl: string, password: string): string {
  const u = new URL(ownerUrl);
  u.username = 'ernie_app';
  u.password = password;
  return u.toString();
}

describe.skipIf(!ready)('sessioni, RLS e costi con Postgres reale (ruolo ernie_app)', () => {
  let owner: Pool;
  let app: Pool;
  let redis: Redis;
  const userA = randomUUID();
  const userB = randomUUID();
  const logger = createLogger({ level: 'silent', name: 't' });

  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    app = createPool({
      connectionString: appUrl(OWNER_URL as string, APP_PASSWORD as string),
      max: 2,
    });
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    await owner.query(
      `INSERT INTO users (id, display_name, role, companion_name) VALUES ($1, 'A', 'owner', 'Ernie'), ($2, 'B', 'member', 'Max')`,
      [userA, userB],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
    await redis.quit();
  });

  it('il ruolo applicativo non vede nulla senza app.user_id', async () => {
    const res = await app.query(`SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])`, [
      [userA, userB],
    ]);
    expect(res.rows[0]?.n).toBe(0);
  });

  it('una sessione di A non è visibile né riutilizzabile da B', async () => {
    const store = createSessionStore(app, redis, { logTtlSeconds: 60 });
    const sessionId = randomUUID();
    const noKey = null as unknown as string; // api_key_id è opzionale
    const a = await store.ensure(userA, noKey, sessionId, { platform: 'test' });
    expect(a.resumed).toBe(false);
    const again = await store.ensure(userA, noKey, sessionId, {});
    expect(again.resumed).toBe(true);
    await expect(store.ensure(userB, noKey, sessionId, {})).rejects.toThrowError(
      SessionForbiddenError,
    );
    const seenByB = await withUser(app, userB, (c) =>
      c.query(`SELECT count(*)::int AS n FROM sessions WHERE id = $1`, [sessionId]),
    );
    expect(seenByB.rows[0]?.n).toBe(0);
    const seenByA = await withUser(app, userA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM sessions WHERE id = $1`, [sessionId]),
    );
    expect(seenByA.rows[0]?.n).toBe(1);
  });

  it('prenota atomicamente una richiesta anche fra due connessioni e conserva il vincolo', async () => {
    const a = createSessionStore(app, redis, { logTtlSeconds: 60 });
    const b = createSessionStore(app, redis, { logTtlSeconds: 60 });
    const sessionId = randomUUID();
    const correlationId = randomUUID();
    const results = await Promise.all([
      a.claimRequest(sessionId, correlationId),
      b.claimRequest(sessionId, correlationId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await createSessionStore(app, redis).claimRequest(sessionId, correlationId)).toBe(false);
    expect(await b.claimRequest(sessionId, randomUUID())).toBe(true);
  });

  it('classe della sessione: sale, ridiscende e il segno della scelta manuale', async () => {
    const store = createSessionStore(app, redis, { logTtlSeconds: 60 });
    const sessionId = randomUUID();
    await store.ensure(userA, null as unknown as string, sessionId, { platform: 'test' });
    expect(await store.raiseModelClass(userA, sessionId, 'standard')).toBe('standard');
    expect(await store.raiseModelClass(userA, sessionId, 'heavy')).toBe('heavy');
    expect(await store.raiseModelClass(userA, sessionId, 'standard')).toBe('heavy');
    expect(await store.lowerModelClass(userA, sessionId)).toBe('standard');
    expect(await store.lowerModelClass(userA, sessionId)).toBe('standard');
    // B non può toccare la sessione di A (RLS): resta quella di A.
    await store.raiseModelClass(userA, sessionId, 'heavy');
    expect(await store.lowerModelClass(userB, sessionId)).toBe('standard');
    expect(await store.raiseModelClass(userA, sessionId, 'standard')).toBe('heavy');
    expect(await store.isModelClassPinned(sessionId)).toBe(false);
    await store.pinModelClass(sessionId, true);
    expect(await store.isModelClassPinned(sessionId)).toBe(true);
    await store.pinModelClass(sessionId, false);
    expect(await store.isModelClassPinned(sessionId)).toBe(false);
  });

  it('seq, log e replay su Redis', async () => {
    const store = createSessionStore(app, redis, { logTtlSeconds: 60 });
    const sessionId = randomUUID();
    expect(await store.nextSeq(sessionId)).toBe(0);
    expect(await store.nextSeq(sessionId)).toBe(1);
    const ctx = { sessionId, correlationId: randomUUID() };
    await store.append(
      sessionId,
      createEvent('assistant.text.delta', { delta: 'a' }, { ...ctx, seq: 0 }),
    );
    await store.append(
      sessionId,
      createEvent('assistant.text.delta', { delta: 'b' }, { ...ctx, seq: 1 }),
    );
    await store.append(
      sessionId,
      createEvent('session.pong', { serverTime: new Date().toISOString() }, { ...ctx, seq: 2 }),
    );
    const replay = await store.replay(sessionId, 0);
    expect(replay.map((e) => e.seq)).toEqual([1]);
    expect(await store.currentSeq(sessionId)).toBe(1);
    expect(await store.isTainted(sessionId)).toBe(false);
    await store.markTainted(sessionId, 'web_fetch:https://x', 60);
    expect(await store.isTainted(sessionId)).toBe(true);
  });

  it('appendWithSeq: un round-trip, sequenze concorrenti, JSON intatto e replay limitato', async () => {
    const store = createSessionStore(app, redis, { logTtlSeconds: 60, logMaxEvents: 20 });
    const sessionId = randomUUID();
    const appendWithSeq = store.appendWithSeq;
    if (!appendWithSeq) throw new Error('atomic append mancante');
    const evalSpy = vi.spyOn(redis, 'eval');
    try {
      const events = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          appendWithSeq(
            sessionId,
            createEvent(
              'assistant.text.delta',
              {
                delta: JSON.stringify({
                  index: i,
                  empty: [],
                  unicode: 'caffè',
                  nested: { seq: 0 },
                }),
              },
              { sessionId, correlationId: randomUUID(), seq: 0 },
            ),
          ),
        ),
      );
      expect(evalSpy).toHaveBeenCalledTimes(30);
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      const replay = await store.replay(sessionId, 24);
      expect(replay.map((e) => e.seq)).toEqual([25, 26, 27, 28, 29]);
      expect(replay.at(-1)).toEqual(events.at(-1));
      expect(await store.replay(sessionId, -1)).toHaveLength(20);
      expect(await redis.ttl(`ernie:sess:${sessionId}:seq`)).toBeGreaterThan(0);
      const pong = await appendWithSeq(
        sessionId,
        createEvent(
          'session.pong',
          { serverTime: new Date().toISOString() },
          { sessionId, correlationId: randomUUID(), seq: 0 },
        ),
      );
      expect(pong.seq).toBe(30);
      expect(await store.replay(sessionId, 29)).toEqual([]);
    } finally {
      evalSpy.mockRestore();
      await redis.del(`ernie:sess:${sessionId}:seq`, `ernie:sess:${sessionId}:log`);
    }
  });

  it('limite predefinito500, array vuoti intatti e rifiuto senza evento se Redis non può persistere', async () => {
    const store = createSessionStore(app, redis);
    const append = store.appendWithSeq;
    if (!append) throw new Error('atomic append mancante');
    const id = randomUUID();
    const seqKey = `ernie:sess:${id}:seq`;
    const logKey = `ernie:sess:${id}:log`;
    try {
      const event = createEvent(
        'assistant.block',
        {
          blockId: 'b',
          block: {
            kind: 'recipes',
            recipes: [{ title: 'Caffè', ingredients: ['acqua'], steps: [], tags: [] }],
          },
        },
        { sessionId: id, correlationId: randomUUID(), seq: 0 },
      );
      await Promise.all(Array.from({ length: 501 }, () => append(id, event)));
      const replay = await store.replay(id, -1);
      expect(replay).toHaveLength(500);
      expect(replay[0]?.seq).toBe(1);
      expect(replay.at(-1)?.payload).toEqual(event.payload);
      expect(await redis.ttl(logKey)).toBeGreaterThan(86300);
      await redis.set(logKey, 'wrong-type');
      await expect(append(id, event)).rejects.toThrow('WRONGTYPE');
      expect(await redis.get(logKey)).toBe('wrong-type');
    } finally {
      await redis.del(seqKey, logKey);
    }
  });

  it('llm_calls per utente e budget giornaliero', async () => {
    const recorder = createLlmCallRecorder(app, logger);
    await recorder.record({
      userId: userA,
      sessionId: null,
      requestId: 'r1',
      stepIndex: 0,
      purpose: 'turn',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      modelClass: 'light',
      generationId: 'gen-x',
      usage: {
        inputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        costReportedUsd: 0.5,
      },
      ttftMs: 100,
      latencyMs: 200,
      finishReason: 'stop',
    });
    const guard = createBudgetGuard(app);
    const spentA = await guard.assertWithinBudget(userA, 1);
    expect(spentA.spentUsd).toBeCloseTo(0.5);
    await expect(guard.assertWithinBudget(userA, 0.4)).rejects.toThrow(/budget/);
    const spentB = await guard.assertWithinBudget(userB, 1);
    expect(spentB.spentUsd).toBe(0);
  });

  it('i Soul globali vengono clonati per utente e il clone sostituisce il globale', async () => {
    const repo = createSoulRepository(app);
    const cloned = await repo.cloneDefaultsForUser(userB, 'test');
    expect(cloned).toBeGreaterThanOrEqual(3);
    expect(await repo.cloneDefaultsForUser(userB, 'test')).toBe(0);
    const souls = await repo.loadForUser(userB);
    expect(souls.filter((s) => s.key === 'core')).toHaveLength(2);
    const updated = await repo.updateContent(
      userB,
      'core',
      'Sei Max, il compagno di B.',
      'test',
      'personalizzazione',
    );
    expect(updated.version).toBe(2);
    const forA = await repo.loadForUser(userA);
    expect(forA.some((s) => s.content.includes('compagno di B'))).toBe(false);
  });
});
