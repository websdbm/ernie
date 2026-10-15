import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClarificationRecorder } from './clarify.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('chiarimento interno: interpretation_checks (Postgres, RLS, 0035)', () => {
  let owner: Pool;
  let app: Pool;
  const a = randomUUID();
  const b = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 2 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'A'), ($2, 'B')`, [a, b]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[a, b]]);
    await owner.end();
    await app.end();
  });

  it('registra domande, risposte e costo; ognuno vede solo i propri', async () => {
    const rec = createClarificationRecorder(app);
    await rec.record({
      userId: a,
      sessionId: null,
      requestId: 'r1',
      message: 'ricordagli di portarlo',
      trigger: 'ambiguous',
      ambiguity: 0.82,
      clarification: {
        trigger: 'ambiguous',
        questions: [{ about: 'lui', question: 'Chi è «lui»?', options: ['Giorgio', 'Fabio'] }],
        answers: [{ about: 'lui', question: 'Chi è «lui»?', meaning: 'Giorgio', confidence: 0.9 }],
        resolved: [{ about: 'lui', meaning: 'Giorgio', confidence: 0.9 }],
        unresolved: [],
        costUsd: 0.0004,
        latencyMs: 420,
      },
    });
    await rec.record({
      userId: a,
      sessionId: null,
      requestId: 'r2',
      message: 'no, intendevo domani',
      trigger: 'correction',
      error: 'tempo scaduto',
      latencyMs: 4500,
    });
    const mine = await withUser(app, a, (c) =>
      c.query<{ trigger: string; resolved: number; questions: unknown[]; error: string | null }>(
        `SELECT trigger, resolved, questions, error FROM interpretation_checks ORDER BY created_at`,
      ),
    );
    expect(mine.rows.map((r) => [r.trigger, r.resolved, r.questions.length, r.error])).toEqual([
      ['ambiguous', 1, 1, null],
      ['correction', 0, 0, 'tempo scaduto'],
    ]);
    const theirs = await withUser(app, b, (c) => c.query(`SELECT 1 FROM interpretation_checks`));
    expect(theirs.rowCount).toBe(0);
  });
});
