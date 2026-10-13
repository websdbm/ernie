import { randomUUID } from 'node:crypto';
import { createPgApprovalStore } from '@ernie/agent-core';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgToolRuleStore } from './rules.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('regole «Consenti sempre» (Postgres, ruolo applicativo + RLS)', () => {
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
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
    await owner.end();
    await app.end();
  });

  it('crea, deduplica, filtra i tool non ammessi, nasce da un’approvazione, si revoca; RLS', async () => {
    const rules = createPgToolRuleStore(app, {
      eligible: (t) => t !== 'send_mail',
      cacheTtlMs: 60_000,
    });
    expect(await rules.allows(userA, 'shopping_list_add')).toBe(false);
    const r1 = await rules.allow(userA, 'shopping_list_add', 'settings');
    const r2 = await rules.allow(userA, 'shopping_list_add', 'card');
    expect(r1?.id).toBe(r2?.id);
    expect(await rules.allow(userA, 'send_mail')).toBeNull();
    expect(await rules.allows(userA, 'shopping_list_add')).toBe(true); // cache invalidata dalla creazione
    expect(await rules.allows(userB, 'shopping_list_add')).toBe(false);
    expect(await rules.list(userB)).toEqual([]);
    expect(await rules.remove(userB, r1?.id as string)).toBe(false);

    // Dalla scheda: il tool viene dall'approvazione (dell'utente stesso), non dal client.
    const approvals = createPgApprovalStore(app);
    const ap = await approvals.create({
      userId: userA,
      sessionId: null,
      requestId: 'r',
      toolCallId: 't',
      toolId: 'web_search',
      args: { query: 'x' },
      reason: 'test',
      ttlMs: 60_000,
    });
    expect(await rules.allowFromApproval(userB, ap.id)).toBeNull();
    expect((await rules.allowFromApproval(userA, ap.id))?.toolId).toBe('web_search');
    expect((await rules.list(userA)).map((r) => r.toolId).sort()).toEqual([
      'shopping_list_add',
      'web_search',
    ]);
    expect(await rules.remove(userA, r1?.id as string)).toBe(true);
    expect(await rules.allows(userA, 'shopping_list_add')).toBe(false);
  });
});
