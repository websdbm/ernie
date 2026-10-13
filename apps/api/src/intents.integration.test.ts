import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FamilyRepository } from './family.js';
import { createIntentStore, GenericTriggerError } from './intents.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('promemoria a evento (Postgres, full-text italiano, freni)', () => {
  let owner: Pool;
  let app: Pool;
  const papa = randomUUID();
  const giorgio = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'P'), ($2, 'G')`, [
      papa,
      giorgio,
    ]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[papa, giorgio]]);
    await owner.end();
    await app.end();
  });

  const family = {
    find: async (u: string, label: string) =>
      u === papa && label.toLowerCase() === 'giorgio'
        ? { otherUserId: giorgio, label: 'Giorgio' }
        : null,
    labelFor: async () => 'papà',
    list: async (u: string) => (u === papa ? [{ otherUserId: giorgio, label: 'Giorgio' }] : []),
  } as unknown as FamilyRepository;

  it('scatta sulle parole (anche flesse), non oltre una volta al giorno, si annulla; argomenti vuoti rifiutati', async () => {
    const store = createIntentStore(app, family);
    await store.create(papa, { trigger: 'gita a Ravenna', reminder: 'firmare il modulo' });
    expect(await store.fire(papa, 'oggi non ho voglia di cucinare')).toEqual([]);
    const fired = await store.fire(papa, 'la gita di Giorgio a Ravenna è giovedì');
    expect(fired.map((f) => f.reminder)).toEqual(['firmare il modulo']);
    // Entro 24 ore non riscatta.
    expect(await store.fire(papa, 'la gita a Ravenna costa 38 euro')).toEqual([]);
    // Dopo 24 ore sì; alla terza volta è finito.
    for (let i = 0; i < 2; i++) {
      await owner.query(
        `UPDATE standing_intents SET last_fired_at = now() - interval '25 hours' WHERE user_id = $1`,
        [papa],
      );
      expect(await store.fire(papa, 'per la gita a Ravenna serve il pranzo al sacco')).toHaveLength(
        1,
      );
    }
    await owner.query(
      `UPDATE standing_intents SET last_fired_at = now() - interval '25 hours' WHERE user_id = $1`,
      [papa],
    );
    expect(await store.fire(papa, 'gita a Ravenna')).toEqual([]);
    await expect(store.create(papa, { trigger: 'il', reminder: 'niente' })).rejects.toBeInstanceOf(
      GenericTriggerError,
    );
    await store.create(papa, { trigger: 'dentista', reminder: 'portare la tessera' });
    expect((await store.cancel(papa, 'dentista'))?.reminder).toBe('portare la tessera');
    expect(await store.fire(papa, 'domani vado dal dentista')).toEqual([]);
  });

  it('famiglia: «quando Giorgio parla…» scatta nei messaggi di Giorgio; papà lo vede nel suo elenco', async () => {
    const store = createIntentStore(app, family);
    const i = await store.create(papa, {
      trigger: 'verifica di storia',
      reminder: 'ripassare i Sumeri',
      forLabel: 'Giorgio',
    });
    expect(i.for).toBe('Giorgio');
    expect((await store.list(papa)).find((x) => x.for === 'Giorgio')?.reminder).toBe(
      'ripassare i Sumeri',
    );
    expect(await store.fire(papa, 'domani c’è la verifica di storia')).toEqual([]);
    expect(await store.fire(giorgio, 'domani ho la verifica di storia')).toMatchObject([
      { reminder: 'ripassare i Sumeri', from: 'papà' },
    ]);
  });
});
