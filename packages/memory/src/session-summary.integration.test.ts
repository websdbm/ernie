import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionSummaryStore } from './session-summary.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('riassunti di sessione (Postgres, RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  const sessionId = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'A'), ($2, 'B')`, [
      userA,
      userB,
    ]);
    await withUser(app, userA, (c) =>
      c.query(`INSERT INTO sessions (id, user_id) VALUES ($1, $2)`, [sessionId, userA]),
    );
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('salva, aggiorna con versione crescente, non si vede da un altro utente', async () => {
    const store = createSessionSummaryStore(app);
    expect(await store.get(userA, sessionId)).toBeNull();
    const sections = {
      topics: ['spesa'],
      done: [],
      open: [],
      preferences: [],
      facts: ['latte 2 l'],
      state: 'ok',
    };
    const t = new Date('2026-10-13T08:10:00Z');
    expect(
      await store.save(userA, sessionId, {
        sections,
        coveredUntil: t,
        messages: 14,
        fallback: false,
      }),
    ).toBe(1);
    expect(
      await store.save(userA, sessionId, {
        sections: { ...sections, state: 'dopo' },
        coveredUntil: new Date('2026-10-13T08:30:00Z'),
        messages: 28,
        fallback: true,
      }),
    ).toBe(2);
    const got = await store.get(userA, sessionId);
    expect(got).toMatchObject({ messages: 28, version: 2, fallback: true });
    expect(got?.sections.state).toBe('dopo');
    expect(got?.coveredUntil.toISOString()).toBe('2026-10-13T08:30:00.000Z');
    expect(await store.get(userB, sessionId)).toBeNull();
  });
});
