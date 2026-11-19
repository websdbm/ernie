import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgApprovalStore } from './approvals.js';

// Dedicated local fixture database only; never infer a production URL from .env.
const url = process.env.REMINDER_APPROVAL_TEST_DATABASE_URL;
const local = url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
describe.skipIf(!local)('scadenza delle conferme (PostgreSQL e RLS)', () => {
  let owner: Pool;
  let app: Pool;
  const a = randomUUID();
  const b = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: url as string });
    const appUrl = new URL(url as string);
    appUrl.username = 'ernie_app';
    appUrl.password = 'local-approval-test';
    app = createPool({ connectionString: appUrl.toString() });
    await owner.query('INSERT INTO users(id,display_name) VALUES($1,$2),($3,$4)', [
      a,
      'Synthetic A',
      b,
      'Synthetic B',
    ]);
  });
  afterAll(async () => {
    await owner?.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b]]);
    await app?.end();
    await owner?.end();
  });
  it('chiude solo richieste proprie, pendenti e scadute; non revoca consensi validi', async () => {
    const store = createPgApprovalStore(app);
    const args = { location: 'Via Esempio 4, Padova' };
    const make = () =>
      store.create({
        userId: a,
        sessionId: null,
        requestId: randomUUID(),
        toolCallId: randomUUID(),
        toolId: 'reminder_update',
        args,
        reason: 'test',
        ttlMs: 60_000,
      });
    const pending = await make();
    await store.expire?.(a, pending.id);
    const status = async (id: string) =>
      (await owner.query('SELECT status FROM tool_approvals WHERE id=$1', [id])).rows[0]?.status;
    expect(await status(pending.id)).toBe('pending');
    await owner.query(
      "UPDATE tool_approvals SET expires_at=now()-interval '1 second' WHERE id=$1",
      [pending.id],
    );
    await store.expire?.(b, pending.id);
    expect(await status(pending.id)).toBe('pending');
    await store.expire?.(a, pending.id);
    expect(await status(pending.id)).toBe('expired');
    expect(await store.consume(a, pending.id, 'reminder_update', args)).toBe(false);
    const approved = await make();
    expect(await store.resolve(a, approved.id, 'approved')).toBe('approved');
    await store.expire?.(a, approved.id);
    expect(await store.consume(a, approved.id, 'reminder_update', args)).toBe(true);
    expect(await store.consume(a, approved.id, 'reminder_update', args)).toBe(false);
    await store.expire?.(a, approved.id);
    expect(await status(approved.id)).toBe('consumed');
  });
});
