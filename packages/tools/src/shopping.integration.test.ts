import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShoppingListRepository } from './builtins/shopping.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('lista della spesa su Postgres (ruolo ernie_app)', () => {
  let owner: Pool;
  let app: Pool;
  const userA = randomUUID();
  const userB = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 2 });
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

  it('aggiunge senza duplicati, aggiorna la quantità, toglie, legge e svuota; isolato per utente', async () => {
    const repo = createShoppingListRepository(app);
    const first = await repo.add(userA, [{ name: 'Latte', quantity: '1 l' }, { name: 'pane' }]);
    expect(first.added.map((i) => i.name)).toEqual(['Latte', 'pane']);
    const again = await repo.add(userA, [{ name: 'latte', quantity: '2 l' }]);
    expect(again.added).toHaveLength(0);
    expect(again.alreadyPresent).toEqual(['latte']);
    expect((await repo.list(userA)).map((i) => `${i.name}:${i.quantity}`)).toEqual([
      'Latte:2 l',
      'pane:null',
    ]);
    expect(await repo.list(userB)).toHaveLength(0);
    const rm = await repo.remove(userA, ['PANE', 'burro']);
    expect(rm.removed).toEqual(['pane']);
    expect(rm.notFound).toEqual(['burro']);
    expect(await repo.markAllBought(userA)).toBe(1);
    expect(await repo.list(userA)).toHaveLength(0);
    const re = await repo.add(userA, [{ name: 'latte' }]);
    expect(re.added).toHaveLength(1);
  });
});
