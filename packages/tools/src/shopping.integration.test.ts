import { randomUUID } from 'node:crypto';
import { createPool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShoppingListRepository } from './builtins/shopping.js';

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL;
const run = APP_URL && OWNER_URL ? describe : describe.skip;

run('liste della spesa (Postgres, RLS)', async () => {
  const app = createPool({ connectionString: APP_URL as string, max: 2 });
  const owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
  const userA = randomUUID();
  const userB = randomUUID();
  beforeAll(async () => {
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

  it('più liste con nome: risoluzione, voci spuntate, archivio; l’altro utente non vede nulla', async () => {
    const repo = createShoppingListRepository(app);
    // Senza liste: la risoluzione crea «Spesa» solo se richiesto.
    expect((await repo.resolve(userA)).kind).toBe('none');
    const spesa = (await repo.resolve(userA, undefined, { createDefault: true })) as {
      kind: 'list';
      list: { id: string; name: string };
    };
    expect(spesa.kind === 'list' && spesa.list.name).toBe('Spesa');

    const r = await repo.add(
      userA,
      spesa.list.id,
      [{ name: 'latte', quantity: '2 l' }, { name: 'pane' }],
      'test',
    );
    expect(r.added.map((i) => i.name)).toEqual(['latte', 'pane']);
    expect((await repo.add(userA, spesa.list.id, [{ name: 'Latte' }])).alreadyPresent).toEqual([
      'Latte',
    ]);

    // Spunta: resta in lista, barrata; riaggiungerla la rimette da prendere.
    expect((await repo.setChecked(userA, spesa.list.id, ['latte'], true)).changed).toEqual([
      'latte',
    ]);
    let items = await repo.items(userA, spesa.list.id);
    expect(items.map((i) => [i.name, i.status])).toEqual([
      ['latte', 'bought'],
      ['pane', 'active'],
    ]);
    await repo.add(userA, spesa.list.id, [{ name: 'latte' }]);
    items = await repo.items(userA, spesa.list.id);
    expect(items.find((i) => i.name === 'latte')?.status).toBe('active');

    // Seconda lista: con due attive e nessuna usata di recente la risoluzione chiede di scegliere…
    const natale = await repo.createList(userA, 'Natale');
    await owner.query(
      `UPDATE shopping_lists SET last_used_at = now() - interval '2 hours' WHERE user_id = $1`,
      [userA],
    );
    expect((await repo.resolve(userA)).kind).toBe('choose');
    // …mentre per nome (anche parziale) trova la lista.
    const byName = await repo.resolve(userA, 'natal');
    expect(byName.kind === 'list' && byName.list.id).toBe(natale.id);
    // Una lista usata da poco vince senza nome.
    await repo.touch(userA, natale.id);
    const recent = await repo.resolve(userA);
    expect(recent.kind === 'list' && recent.list.id).toBe(natale.id);

    // Archivio e ripristino; conteggi.
    await repo.setListStatus(userA, natale.id, 'archived');
    expect((await repo.lists(userA)).map((l) => l.name)).toEqual(['Spesa']);
    expect((await repo.lists(userA, { includeArchived: true })).length).toBe(2);
    const restored = await repo.setListStatus(userA, natale.id, 'active');
    expect(restored?.status).toBe('active');
    const counts = await repo.getList(userA, spesa.list.id);
    expect([counts?.open, counts?.bought]).toEqual([2, 0]);

    // Chiusura: tutto preso, poi via le prese.
    expect(await repo.markAllBought(userA, spesa.list.id)).toBe(2);
    expect(await repo.clearBought(userA, spesa.list.id)).toBe(2);
    expect(await repo.items(userA, spesa.list.id)).toEqual([]);

    // Isolamento per utente.
    expect(await repo.lists(userB, { includeArchived: true })).toEqual([]);
    expect(await repo.getList(userB, spesa.list.id)).toBeNull();
    expect(await repo.deleteList(userA, natale.id)).toBe(true);
    expect((await repo.lists(userA, { includeArchived: true })).map((l) => l.name)).toEqual([
      'Spesa',
    ]);
  });
});
