import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAutomationRepository } from './repository.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)(
  'sentinelle: politica di avviso, stato del controllo, doppioni, esiti silenziosi',
  () => {
    let owner: Pool;
    let app: Pool;
    const user = randomUUID();
    beforeAll(async () => {
      owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
      const u = new URL(OWNER_URL as string);
      u.username = 'ernie_app';
      u.password = APP_PASSWORD as string;
      app = createPool({ connectionString: u.toString(), max: 4 });
      await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'S')`, [user]);
    });
    afterAll(async () => {
      await owner.query(`DELETE FROM users WHERE id = $1`, [user]);
      await owner.end();
      await app.end();
    });

    it('salva politica, condizione e controllo; stato, doppioni e silenziosi letti una volta', async () => {
      const repo = createAutomationRepository(app);
      const a = await repo.create(
        user,
        {
          key: 'sentinella_test',
          title: 'Versione 2.0',
          trigger: { type: 'cron', pattern: '0 9 * * *' },
          action: {
            type: 'guided',
            instructions: 'Controlla la pagina delle versioni.',
            allowedTools: ['web_fetch'],
          },
          notifyPolicy: 'if_condition',
          condition: 'esce la versione 2.0',
          check: { type: 'page_changed', url: 'https://esempio.it/versioni' },
        },
        { knownTools: ['web_fetch'] },
      );
      expect(a).toMatchObject({
        notifyPolicy: 'if_condition',
        condition: 'esce la versione 2.0',
        check: { type: 'page_changed', url: 'https://esempio.it/versioni' },
        checkState: null,
      });
      await repo.saveCheckState(user, a.id, { hash: 'abc' });
      expect((await repo.get(user, a.id))?.checkState).toEqual({ hash: 'abc' });

      expect(await repo.recentlyNotified(user, a.id, 'h1')).toBe(false);
      await repo.notify(user, {
        kind: 'automation.result',
        title: 't',
        body: 'b',
        payload: { automationId: a.id, hash: 'h1' },
      });
      expect(await repo.recentlyNotified(user, a.id, 'h1')).toBe(true);
      expect(await repo.recentlyNotified(user, a.id, 'h2')).toBe(false);

      await withUser(app, user, (c) =>
        c.query(
          `INSERT INTO automation_runs (automation_id, user_id, scheduled_at, dedupe_key, trigger_type, status, outcome, finished_at)
         VALUES ($1, $2, now(), 'cron:s1', 'cron', 'succeeded', '{"summary":"ancora 1.9","silent":true}', now())`,
          [a.id, user],
        ),
      );
      expect(await repo.takeSilentRuns(user)).toMatchObject([
        { title: 'Versione 2.0', summary: 'ancora 1.9' },
      ]);
      expect(await repo.takeSilentRuns(user)).toEqual([]);
    });
  },
);
