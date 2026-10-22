import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consolidateThread, type Extractor } from './consolidate.js';
import { createFakeEmbedder } from './embeddings.js';
import { createProfileStore } from './profile.js';
import { createMemoryRepository } from './repository.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('scheda anagrafica su Postgres (RLS, consolidamento)', () => {
  let owner: Pool;
  let app: Pool;
  const user = randomUUID();
  const other = randomUUID();
  const logger = createLogger({ level: 'silent', name: 't' });

  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 3 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'P'), ($2, 'Q')`, [
      user,
      other,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[user, other]]);
    await owner.end();
    await app.end();
  });

  it('il consolidamento riempie la scheda, avvisa una volta e la RLS la isola', async () => {
    const profiles = createProfileStore(app);
    const now = Date.now();
    const threads = {
      async recall() {
        return {
          messages: [
            {
              role: 'user',
              content: 'Mi chiamo Alessandro ma chiamami Ale, sono nato il 3 maggio 1975',
              createdAt: new Date(now - 2000),
            },
            { role: 'assistant', content: 'Piacere, Ale!', createdAt: new Date(now - 1000) },
          ],
        };
      },
    };
    const extractor: Extractor = async () => ({
      facts: [],
      profile: {
        fullName: 'Alessandro',
        preferredName: 'Ale',
        birthDate: '1975-05-03',
        evidence: 'chiamami Ale',
      },
    });
    const result = await consolidateThread(
      {
        pool: app,
        repo: createMemoryRepository(app, createFakeEmbedder(1536), { logger }),
        threads,
        gateway: null as never,
        recorder: { record: async () => {} },
        logger,
        extractor,
        judge: null,
        profiles,
      },
      { userId: user, threadId: `t-${randomUUID()}`, sessionId: null },
    );
    expect(result.profileChanges).toBe(3);
    expect(await profiles.get(user)).toMatchObject({
      preferredName: 'Ale',
      birthDate: '1975-05-03',
    });
    const notices = await profiles.pendingNotices(user);
    expect(notices).toHaveLength(1);
    await profiles.markNotified(
      user,
      notices.map((n) => n.id),
    );
    expect(await profiles.pendingNotices(user)).toEqual([]);
    expect(await profiles.get(other)).toMatchObject({ family: [], meta: {} });
    expect((await profiles.get(other)).preferredName).toBeUndefined();
  });
});

// La serializzazione SQL impedisce che due heartbeat creino due revisioni della stessa unione.
describe.skipIf(!ready)('identità familiari atomiche', () => {
  it('due consolidamenti concorrenti producono una sola revisione e non toccano altri utenti', async () => {
    const owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    const app = createPool({ connectionString: u.toString(), max: 3 });
    const user = randomUUID();
    const other = randomUUID();
    try {
      await owner.query(
        "INSERT INTO users (id, display_name) VALUES ($1, 'Merge test'), ($2, 'Other')",
        [user, other],
      );
      const profiles = createProfileStore(app);
      await profiles.save(
        user,
        {
          family: [
            {
              id: 'a',
              name: 'Anna Rossi',
              relation: 'compagna',
              birthDate: '1980-01-01',
              meta: { source: 'user', at: '2026-01-01' },
            },
            {
              id: 'b',
              name: 'Anna',
              relation: 'compagna',
              notes: 'Scarpe 41',
              meta: { source: 'user', at: '2026-01-01' },
            },
          ],
          places: [],
          meta: {},
        },
        [{ field: 'family', before: null, after: 'fixture' }],
        'user',
      );
      const results = await Promise.all([
        profiles.consolidateFamily(user, 'Anna Rossi', ['Anna']),
        profiles.consolidateFamily(user, 'Anna Rossi', ['Anna']),
      ]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect((await profiles.get(user)).family).toHaveLength(1);
      expect((await profiles.get(user)).family[0]?.notes).toBe('Scarpe 41');
      expect((await profiles.get(other)).family).toEqual([]);
      const rows = await owner.query(
        'SELECT count(*)::int AS n FROM user_profile_revisions WHERE user_id = $1',
        [user],
      );
      expect(rows.rows[0].n).toBe(2);
    } finally {
      await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[user, other]]);
      await app.end();
      await owner.end();
    }
  });
});
