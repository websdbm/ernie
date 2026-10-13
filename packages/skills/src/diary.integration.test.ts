import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgActivityStore } from './diary.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('diario: archivio Postgres (ruolo applicativo + RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
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
    await withUser(app, userA, async (c) => {
      const list = await c.query<{ id: string }>(
        `INSERT INTO shopping_lists (user_id, name, name_norm) VALUES ($1, 'Spesa', 'spesa') RETURNING id`,
        [userA],
      );
      const listId = list.rows[0]?.id;
      await c.query(
        `INSERT INTO shopping_items (user_id, list_id, name, name_norm) VALUES ($1, $2, 'latte', 'latte')`,
        [userA, listId],
      );
      await c.query(
        `INSERT INTO shopping_items (user_id, list_id, name, name_norm, status, bought_at) VALUES ($1, $2, 'uova', 'uova', 'bought', now())`,
        [userA, listId],
      );
      await c.query(
        `INSERT INTO recipes (user_id, title, title_norm) VALUES ($1, 'Carbonara', 'carbonara')`,
        [userA],
      );
      await c.query(
        `INSERT INTO documents (user_id, title, source, pages, chars, page_texts, body) VALUES ($1, 'I Sumeri', 'scan', 1, 10, '["x"]', 'x')`,
        [userA],
      );
      for (const [tool, preview, verdict, ok, approved, err] of [
        ['web_search', '{"query":"chi erano i Sumeri","limit":3}', 'allow', true, null, null],
        ['web_fetch', '{"url":"https://it.wikipedia.org/wiki/Uruk"}', 'allow', true, null, null],
        [
          'shopping_list_add',
          '{"items":[{"name":"zucchero"}]}',
          'ask',
          false,
          false,
          'non autorizzato (expired)',
        ],
      ] as const)
        await c.query(
          `INSERT INTO tool_calls (user_id, request_id, tool_call_id, tool_id, args_hash, args_preview, verdict, ok, approved, error)
           VALUES ($1, 'r', $2, $3, 'h', $4, $5, $6, $7, $8)`,
          [userA, randomUUID(), tool, preview, verdict, ok, approved, err],
        );
      const rem = await c.query<{ id: string }>(
        `INSERT INTO automations (user_id, key, title, kind, trigger, action, meta)
         VALUES ($1, 'promemoria_test1', 'Promemoria da papà: chiamarmi', 'deterministic', $2, '{"type":"skill","skillId":"ricordami"}', '{"toLabel":"Giorgio"}') RETURNING id`,
        [userA, JSON.stringify({ type: 'once', at: new Date().toISOString() })],
      );
      await c.query(
        `INSERT INTO automation_runs (automation_id, user_id, scheduled_at, dedupe_key, trigger_type, status, finished_at)
         VALUES ($1, $2, now(), 'once:x', 'once', 'succeeded', now())`,
        [rem.rows[0]?.id, userA],
      );
      const auto = await c.query<{ id: string }>(
        `INSERT INTO automations (user_id, key, title, kind, trigger, action)
         VALUES ($1, 'lista_sera', 'Lista della sera', 'deterministic', '{"type":"cron","pattern":"0 18 * * *"}', '{"type":"skill","skillId":"shopping_list"}') RETURNING id`,
        [userA],
      );
      await c.query(
        `INSERT INTO automation_runs (automation_id, user_id, scheduled_at, dedupe_key, trigger_type, status, finished_at)
         VALUES ($1, $2, now(), 'cron:x', 'cron', 'succeeded', now())`,
        [auto.rows[0]?.id, userA],
      );
      await c.query(
        `INSERT INTO memories (user_id, kind, content, content_hash) VALUES ($1, 'semantic', 'Preferisce il tè', 'h1')`,
        [userA],
      );
      await c.query(
        `INSERT INTO llm_calls (user_id, request_id, provider, model, cost_estimated_usd, cost_reported_usd)
         VALUES ($1, 'r', 'openrouter', 'm', 0.02, 0.01), ($1, 'r', 'openrouter', 'm', 0.03, NULL)`,
        [userA],
      );
    });
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('aggrega i registri del giorno per utente', async () => {
    const store = createPgActivityStore(app);
    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 60_000);
    const s = await store.summary(userA, from, to);
    expect(s.shoppingAdded).toEqual(
      expect.arrayContaining([
        { name: 'latte', list: 'Spesa' },
        { name: 'uova', list: 'Spesa' },
      ]),
    );
    expect(s.shoppingBought).toEqual([{ name: 'uova', list: 'Spesa' }]);
    expect(s.recipes).toEqual([{ title: 'Carbonara', version: 1, created: true }]);
    expect(s.documents).toEqual([{ title: 'I Sumeri' }]);
    expect(s.webSearches).toEqual(['chi erano i Sumeri']);
    expect(s.webPages).toEqual(['https://it.wikipedia.org/wiki/Uruk']);
    expect(s.remindersFired.map((r) => r.text)).toEqual(['chiamarmi']);
    expect(s.remindersCreated).toMatchObject([{ text: 'chiamarmi', forLabel: 'Giorgio' }]);
    expect(s.automations).toMatchObject([{ title: 'Lista della sera', status: 'succeeded' }]);
    expect(s.memories).toEqual(['Preferisce il tè']);
    expect(s.blocked).toEqual([
      { toolId: 'shopping_list_add', reason: 'non autorizzato (expired)' },
    ]);
    expect(s.llm.calls).toBe(2);
    expect(s.llm.costUsd).toBeCloseTo(0.04, 6);
    // L'altro utente non vede nulla (RLS).
    const b = await store.summary(userB, from, to);
    expect(b.shoppingAdded).toEqual([]);
    expect(b.llm.calls).toBe(0);
  });
});
