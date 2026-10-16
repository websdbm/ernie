import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consolidateThread, type Extractor } from './consolidate.js';
import { createFakeEmbedder } from './embeddings.js';
import { createLexiconStore } from './lexicon.js';
import { createMemoryRepository } from './repository.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('lessico imparato su Postgres (soglie, RLS, genitore)', () => {
  let owner: Pool;
  let app: Pool;
  const child = randomUUID();
  const parent = randomUUID();
  const stranger = randomUUID();
  const logger = createLogger({ level: 'silent', name: 't' });
  const s1 = randomUUID();
  const s2 = randomUUID();

  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 3 });
    await owner.query(
      `INSERT INTO users (id, display_name, settings) VALUES ($1, 'G', '{"conversationStyle":"antico"}'), ($2, 'A', '{}'), ($3, 'S', '{}')`,
      [child, parent, stranger],
    );
    await owner.query(`INSERT INTO guardianships (guardian_id, child_id) VALUES ($1, $2)`, [
      parent,
      child,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[child, parent, stranger]]);
    await owner.end();
    await app.end();
  });

  it('diventa attiva dopo tre volte in due conversazioni; la stessa conversazione non basta', async () => {
    const lex = createLexiconStore(app);
    const ci = [{ term: 'ci sta', meaning: 'va bene', example: 'ci sta, domani' }];
    expect(await lex.learn(child, s1, ci)).toEqual({ recorded: 1, activated: 0 });
    expect(await lex.learn(child, s1, ci)).toEqual({ recorded: 1, activated: 0 });
    expect(await lex.learn(child, s1, [{ term: 'bro' }])).toEqual({ recorded: 1, activated: 0 });
    await lex.learn(child, s1, [{ term: 'Bro!' }]);
    await lex.learn(child, s1, [{ term: 'bro' }]);
    expect((await lex.listActive(child)).map((w) => w.term)).toEqual([]);
    expect(await lex.learn(child, s2, ci)).toEqual({ recorded: 1, activated: 1 });
    const active = await lex.listActive(child);
    expect(active.map((w) => [w.term, w.meaning, w.seenCount])).toEqual([['ci sta', 'va bene', 3]]);
    // «bro» tre volte ma in una sola conversazione: resta in osservazione.
    expect((await lex.list(child)).find((w) => w.term === 'bro')?.status).toBe('candidate');
  });

  it('parolacce mai; una parola cancellata non torna', async () => {
    const lex = createLexiconStore(app);
    expect(await lex.learn(child, s1, [{ term: 'che cazzo' }])).toEqual({
      recorded: 0,
      activated: 0,
    });
    const bro = (await lex.list(child)).find((w) => w.term === 'bro');
    expect(bro).toBeDefined();
    expect(await lex.remove(child, bro?.id as string)).toBe(true);
    expect(await lex.learn(child, s2, [{ term: 'bro' }])).toEqual({ recorded: 0, activated: 0 });
    expect((await lex.list(child)).some((w) => w.term === 'bro')).toBe(false);
  });

  it('il genitore vede le parole del figlio, un estraneo no; il genitore può spegnere l’apprendimento', async () => {
    const lex = createLexiconStore(app);
    expect((await lex.listForGuardian(parent, child)).map((w) => w.term)).toEqual(['ci sta']);
    expect(await lex.listForGuardian(stranger, child)).toEqual([]);
    // Stile del figlio solo a chi lo segue (funzione SECURITY DEFINER).
    const style = (who: string) =>
      withUser(
        app,
        who,
        async (c) => (await c.query(`SELECT * FROM guardian_child_style($1)`, [child])).rows,
      );
    expect(await style(parent)).toEqual([{ o_style: 'antico', o_learn: true }]);
    expect(await style(stranger)).toEqual([]);
    // Il figlio non può spegnere da sé il blocco del genitore (UPDATE solo per il genitore).
    await withUser(app, child, (c) =>
      c.query(`UPDATE guardianships SET lexicon_off = true WHERE child_id = $1`, [child]),
    );
    expect(await lex.learningEnabled(child)).toBe(true);
    await withUser(app, parent, (c) =>
      c.query(
        `UPDATE guardianships SET lexicon_off = true WHERE guardian_id = $1 AND child_id = $2`,
        [parent, child],
      ),
    );
    expect(await lex.learningEnabled(child)).toBe(false);
    expect(await lex.learn(child, s2, [{ term: 'top' }])).toEqual({ recorded: 0, activated: 0 });
  });

  it('spento dall’utente nelle impostazioni: niente apprendimento; il consolidamento passa le espressioni', async () => {
    const lex = createLexiconStore(app);
    const extractor: Extractor = async () => ({
      facts: [],
      profile: null,
      expressions: [{ term: 'sbatti', meaning: 'fatica', example: 'che sbatti' }],
    });
    const now = Date.now();
    const run = (userId: string) =>
      consolidateThread(
        {
          pool: app,
          repo: createMemoryRepository(app, createFakeEmbedder(1536), { logger }),
          threads: {
            async recall() {
              return {
                messages: [{ role: 'user', content: 'che sbatti oggi', createdAt: new Date(now) }],
              };
            },
          },
          gateway: null as never,
          recorder: { record: async () => {} },
          logger,
          extractor,
          judge: null,
          lexicon: lex,
        },
        { userId, threadId: `t-${randomUUID()}`, sessionId: s1 },
      );
    expect((await run(stranger)).expressions).toBe(1);
    expect((await lex.list(stranger)).map((w) => w.term)).toEqual(['sbatti']);
    await withUser(app, stranger, (c) =>
      c.query(`UPDATE users SET settings = settings || '{"learnLexicon":false}' WHERE id = $1`, [
        stranger,
      ]),
    );
    expect(await lex.learningEnabled(stranger)).toBe(false);
    expect((await run(stranger)).expressions).toBe(0);
    // Un altro utente non vede il lessico altrui (RLS).
    expect(await lex.list(parent)).toEqual([]);
  });
});
