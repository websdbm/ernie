import { type Pool, withUser } from '@ernie/db';
import type { ContentBlock } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

/**
 * Liste della spesa multiple (decisione dell'utente, 11 ott 2026): ogni lista ha un nome, si archivia e si
 * richiama in qualunque conversazione; le voci si spuntano («prese») dalla scheda interattiva dell'app
 * (REST) oppure a parole (skill deterministica e tool). Quando il nome della lista manca ed è ambiguo,
 * la risposta è una scelta tra le liste, mai un'ipotesi.
 */
export interface ShoppingList {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date;
  /** Voci ancora da prendere e voci prese. */
  readonly open: number;
  readonly bought: number;
}

export interface ShoppingItem {
  readonly id: string;
  readonly listId: string;
  readonly name: string;
  readonly quantity: string | null;
  readonly status: 'active' | 'bought' | 'removed';
  readonly addedAt: Date;
  readonly boughtAt: Date | null;
}

export type ListResolution =
  | { readonly kind: 'list'; readonly list: ShoppingList }
  | { readonly kind: 'choose'; readonly lists: ShoppingList[]; readonly suggested?: true }
  | { readonly kind: 'none' };

export function normalizeItemName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const DEFAULT_LIST_NAME = 'Spesa';

export interface ShoppingListRepository {
  lists(userId: string, opts?: { includeArchived?: boolean }): Promise<ShoppingList[]>;
  getList(userId: string, listId: string): Promise<ShoppingList | null>;
  /** Crea la lista; se esiste (anche archiviata) la riattiva e la restituisce. */
  createList(userId: string, name: string): Promise<ShoppingList>;
  renameList(userId: string, listId: string, name: string): Promise<ShoppingList | null>;
  setListStatus(
    userId: string,
    listId: string,
    status: 'active' | 'archived',
  ): Promise<ShoppingList | null>;
  deleteList(userId: string, listId: string): Promise<boolean>;
  /**
   * Trova la lista intesa: per nome (esatto, poi contenuto) oppure, senza nome, l'unica attiva o quella usata
   * negli ultimi `recentMinutes`; altrimenti chiede di scegliere. Senza liste crea «Spesa» se `createDefault`.
   */
  resolve(
    userId: string,
    hint?: string | null,
    opts?: { createDefault?: boolean; recentMinutes?: number },
  ): Promise<ListResolution>;
  touch(userId: string, listId: string): Promise<void>;
  /** Voci da prendere e prese (le tolte no), nell'ordine di inserimento. */
  items(userId: string, listId: string): Promise<ShoppingItem[]>;
  add(
    userId: string,
    listId: string,
    items: ReadonlyArray<{ name: string; quantity?: string | null | undefined }>,
    source?: string,
  ): Promise<{ added: ShoppingItem[]; alreadyPresent: string[] }>;
  remove(
    userId: string,
    listId: string,
    names: readonly string[],
  ): Promise<{ removed: string[]; notFound: string[] }>;
  setChecked(
    userId: string,
    listId: string,
    names: readonly string[],
    checked: boolean,
  ): Promise<{ changed: string[]; notFound: string[] }>;
  setItemChecked(
    userId: string,
    listId: string,
    itemId: string,
    checked: boolean,
  ): Promise<ShoppingItem | null>;
  removeItem(userId: string, listId: string, itemId: string): Promise<boolean>;
  /** Toglie dalla lista le voci prese. */
  clearBought(userId: string, listId: string): Promise<number>;
  /** Segna tutte le voci come prese («ho fatto la spesa»). */
  markAllBought(userId: string, listId: string): Promise<number>;
  /** Toglie tutte le voci («svuota la lista»). */
  empty(userId: string, listId: string): Promise<number>;
}

/** Un nome non trovato non implica una nuova lista: propone le attive senza sceglierle al posto dell'utente. */
export async function resolveShoppingTarget(
  repo: ShoppingListRepository,
  userId: string,
  hint: string | undefined,
  opts: { createDefault?: boolean; suggestExisting?: boolean } = {},
): Promise<ListResolution> {
  const result = await repo.resolve(userId, hint, { createDefault: opts.createDefault ?? false });
  if (result.kind !== 'none' || !hint || !opts.suggestExisting) return result;
  const active = (await repo.lists(userId)).filter((list) => list.status === 'active');
  return active.length ? { kind: 'choose', lists: active, suggested: true } : result;
}

export function shoppingChoiceQuestion(lists: readonly ShoppingList[]): string {
  return lists.length === 1 && lists[0]
    ? `Vuoi usare la lista «${lists[0].name}»?`
    : 'Quale lista vuoi usare?';
}

export function shoppingAddRequest(
  items: ReadonlyArray<{ name: string; quantity?: string | undefined }>,
): string {
  return `aggiungi ${items.map((item) => (item.quantity ? `${item.quantity} ${item.name}` : item.name)).join(', ')} nella lista «{lista}»`;
}

interface ListRow {
  id: string;
  name: string;
  status: 'active' | 'archived';
  created_at: Date;
  updated_at: Date;
  last_used_at: Date;
  open: string | number;
  bought: string | number;
}
interface ItemRow {
  id: string;
  list_id: string;
  name: string;
  quantity: string | null;
  status: ShoppingItem['status'];
  added_at: Date;
  bought_at: Date | null;
}
const toList = (r: ListRow): ShoppingList => ({
  id: r.id,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  open: Number(r.open),
  bought: Number(r.bought),
});
const toItem = (r: ItemRow): ShoppingItem => ({
  id: r.id,
  listId: r.list_id,
  name: r.name,
  quantity: r.quantity,
  status: r.status,
  addedAt: r.added_at,
  boughtAt: r.bought_at,
});

const LIST_COLS = `l.id, l.name, l.status, l.created_at, l.updated_at, l.last_used_at,
  (SELECT count(*) FROM shopping_items i WHERE i.list_id = l.id AND i.status = 'active') AS open,
  (SELECT count(*) FROM shopping_items i WHERE i.list_id = l.id AND i.status = 'bought') AS bought`;
const ITEM_COLS = 'id, list_id, name, quantity, status, added_at, bought_at';

/** Blocco della scheda interattiva (protocollo v1.4). */
export function toShoppingBlock(list: ShoppingList, items: readonly ShoppingItem[]): ContentBlock {
  return {
    kind: 'shopping_list',
    listId: list.id,
    name: list.name.slice(0, 60),
    status: list.status,
    items: items
      .filter((i) => i.status !== 'removed')
      .slice(0, 200)
      .map((i) => ({
        id: i.id,
        name: i.name.slice(0, 120),
        ...(i.quantity ? { quantity: i.quantity.slice(0, 40) } : {}),
        checked: i.status === 'bought',
      })),
  };
}

export function toChooserBlock(
  lists: readonly ShoppingList[],
  title = 'Quale lista?',
  pendingText?: string,
): ContentBlock {
  return {
    kind: 'shopping_lists',
    title,
    lists: lists.slice(0, 50).map((l) => ({
      id: l.id,
      name: l.name.slice(0, 60),
      open: l.open,
      bought: l.bought,
      archived: l.status === 'archived',
    })),
    // Mai troncare a metà una richiesta: il tap deve conservare anche elenchi lunghi e quantità.
    ...(pendingText
      ? {
          pendingText:
            pendingText.length <= 31_900
              ? pendingText
              : 'Usa la lista «{lista}» per completare la mia richiesta precedente.',
        }
      : {}),
  };
}

export function createShoppingListRepository(pool: Pool): ShoppingListRepository {
  const getListWith = async (
    client: { query: Pool['query'] },
    userId: string,
    listId: string,
  ): Promise<ShoppingList | null> => {
    const res = await client.query<ListRow>(
      `SELECT ${LIST_COLS} FROM shopping_lists l WHERE l.user_id = $1 AND l.id = $2::uuid AND l.status <> 'deleted'`,
      [userId, listId],
    );
    const r = res.rows[0];
    return r ? toList(r) : null;
  };

  const repo: ShoppingListRepository = {
    async lists(userId, opts) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<ListRow>(
          `SELECT ${LIST_COLS} FROM shopping_lists l
           WHERE l.user_id = $1 AND l.status <> 'deleted' ${opts?.includeArchived ? '' : "AND l.status = 'active'"}
           ORDER BY (l.status = 'active') DESC, l.last_used_at DESC`,
          [userId],
        );
        return res.rows.map(toList);
      });
    },
    async getList(userId, listId) {
      return withUser(pool, userId, async (client) => getListWith(client, userId, listId));
    },
    async createList(userId, name) {
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60) || DEFAULT_LIST_NAME;
      const norm = normalizeItemName(clean) || 'spesa';
      return withUser(pool, userId, async (client) => {
        const existing = await client.query<{ id: string }>(
          `UPDATE shopping_lists SET status = 'active', last_used_at = now(), updated_at = now()
           WHERE user_id = $1 AND name_norm = $2 AND status <> 'deleted' RETURNING id`,
          [userId, norm],
        );
        const id =
          existing.rows[0]?.id ??
          (
            await client.query<{ id: string }>(
              `INSERT INTO shopping_lists (user_id, name, name_norm) VALUES ($1, $2, $3) RETURNING id`,
              [userId, clean, norm],
            )
          ).rows[0]?.id;
        if (!id) throw new Error('lista non creata');
        const list = await getListWith(client, userId, id);
        if (!list) throw new Error('lista non trovata dopo la creazione');
        return list;
      });
    },
    async renameList(userId, listId, name) {
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!clean) return null;
      return withUser(pool, userId, async (client) => {
        await client.query(
          `UPDATE shopping_lists SET name = $3, name_norm = $4, updated_at = now(), last_used_at = now()
           WHERE user_id = $1 AND id = $2::uuid AND status <> 'deleted'`,
          [userId, listId, clean, normalizeItemName(clean)],
        );
        return getListWith(client, userId, listId);
      });
    },
    async setListStatus(userId, listId, status) {
      return withUser(pool, userId, async (client) => {
        await client.query(
          `UPDATE shopping_lists SET status = $3, updated_at = now(), last_used_at = now()
           WHERE user_id = $1 AND id = $2::uuid AND status <> 'deleted'`,
          [userId, listId, status],
        );
        return getListWith(client, userId, listId);
      });
    },
    async deleteList(userId, listId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE shopping_lists SET status = 'deleted', updated_at = now() WHERE user_id = $1 AND id = $2::uuid AND status <> 'deleted'`,
          [userId, listId],
        );
        return (res.rowCount ?? 0) > 0;
      });
    },
    async resolve(userId, hint, opts) {
      const all = await repo.lists(userId, { includeArchived: true });
      const active = all.filter((l) => l.status === 'active');
      const h = hint ? normalizeItemName(hint) : '';
      if (h) {
        const exact = all.filter((l) => normalizeItemName(l.name) === h);
        if (exact.length === 1 && exact[0]) return { kind: 'list', list: exact[0] };
        const partial = all.filter((l) => {
          const n = normalizeItemName(l.name);
          return n.includes(h) || h.includes(n);
        });
        const partialActive = partial.filter((l) => l.status === 'active');
        const pick = partialActive.length ? partialActive : partial;
        if (pick.length === 1 && pick[0]) return { kind: 'list', list: pick[0] };
        if (pick.length > 1) return { kind: 'choose', lists: pick };
        return { kind: 'none' };
      }
      if (active.length === 1 && active[0]) return { kind: 'list', list: active[0] };
      if (active.length === 0) {
        if (opts?.createDefault)
          return { kind: 'list', list: await repo.createList(userId, DEFAULT_LIST_NAME) };
        return all.length ? { kind: 'choose', lists: all } : { kind: 'none' };
      }
      const recentMs = (opts?.recentMinutes ?? 30) * 60_000;
      const [first, second] = active;
      if (
        first &&
        Date.now() - first.lastUsedAt.getTime() < recentMs &&
        (!second || first.lastUsedAt.getTime() > second.lastUsedAt.getTime())
      )
        return { kind: 'list', list: first };
      return { kind: 'choose', lists: active };
    },
    async touch(userId, listId) {
      await withUser(pool, userId, async (client) => {
        await client.query(
          `UPDATE shopping_lists SET last_used_at = now() WHERE user_id = $1 AND id = $2::uuid`,
          [userId, listId],
        );
      });
    },
    async items(userId, listId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<ItemRow>(
          `SELECT ${ITEM_COLS} FROM shopping_items WHERE user_id = $1 AND list_id = $2::uuid AND status <> 'removed' ORDER BY added_at`,
          [userId, listId],
        );
        return res.rows.map(toItem);
      });
    },
    async add(userId, listId, items, source = 'user') {
      return withUser(pool, userId, async (client) => {
        const added: ShoppingItem[] = [];
        const alreadyPresent: string[] = [];
        for (const it of items) {
          const name = it.name.trim();
          if (!name) continue;
          const norm = normalizeItemName(name);
          const res = await client.query<ItemRow>(
            `INSERT INTO shopping_items (user_id, list_id, name, name_norm, quantity, source, added_at)
             VALUES ($1, $2::uuid, $3, $4, $5, $6, clock_timestamp())
             ON CONFLICT (list_id, name_norm) WHERE status <> 'removed' DO NOTHING
             RETURNING ${ITEM_COLS}`,
            [userId, listId, name, norm, it.quantity ?? null, source],
          );
          const row = res.rows[0];
          if (row) added.push(toItem(row));
          else {
            // Già in lista: aggiorna la quantità e, se era presa, la rimette da prendere.
            await client.query(
              `UPDATE shopping_items SET quantity = COALESCE($4, quantity), status = 'active', bought_at = NULL
               WHERE user_id = $1 AND list_id = $2::uuid AND name_norm = $3 AND status <> 'removed'`,
              [userId, listId, norm, it.quantity ?? null],
            );
            alreadyPresent.push(name);
          }
        }
        await client.query(
          `UPDATE shopping_lists SET last_used_at = now(), updated_at = now() WHERE user_id = $1 AND id = $2::uuid`,
          [userId, listId],
        );
        return { added, alreadyPresent };
      });
    },
    async remove(userId, listId, names) {
      return withUser(pool, userId, async (client) => {
        const removed: string[] = [];
        const notFound: string[] = [];
        for (const n of names) {
          const norm = normalizeItemName(n);
          const res = await client.query<{ name: string }>(
            `UPDATE shopping_items SET status = 'removed', removed_at = now()
             WHERE user_id = $1 AND list_id = $2::uuid AND status <> 'removed' AND (name_norm = $3 OR name_norm LIKE $4) RETURNING name`,
            [userId, listId, norm, `%${norm}%`],
          );
          if (res.rowCount) removed.push(...res.rows.map((r) => r.name));
          else notFound.push(n);
        }
        return { removed, notFound };
      });
    },
    async setChecked(userId, listId, names, checked) {
      return withUser(pool, userId, async (client) => {
        const changed: string[] = [];
        const notFound: string[] = [];
        for (const n of names) {
          const norm = normalizeItemName(n);
          const res = await client.query<{ name: string }>(
            `UPDATE shopping_items SET status = $5, bought_at = CASE WHEN $5 = 'bought' THEN now() ELSE NULL END
             WHERE user_id = $1 AND list_id = $2::uuid AND status <> 'removed' AND (name_norm = $3 OR name_norm LIKE $4) RETURNING name`,
            [userId, listId, norm, `%${norm}%`, checked ? 'bought' : 'active'],
          );
          if (res.rowCount) changed.push(...res.rows.map((r) => r.name));
          else notFound.push(n);
        }
        return { changed, notFound };
      });
    },
    async setItemChecked(userId, listId, itemId, checked) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<ItemRow>(
          `UPDATE shopping_items SET status = $4, bought_at = CASE WHEN $4 = 'bought' THEN now() ELSE NULL END
           WHERE user_id = $1 AND list_id = $2::uuid AND id = $3::uuid AND status <> 'removed' RETURNING ${ITEM_COLS}`,
          [userId, listId, itemId, checked ? 'bought' : 'active'],
        );
        const r = res.rows[0];
        return r ? toItem(r) : null;
      });
    },
    async removeItem(userId, listId, itemId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE shopping_items SET status = 'removed', removed_at = now()
           WHERE user_id = $1 AND list_id = $2::uuid AND id = $3::uuid AND status <> 'removed'`,
          [userId, listId, itemId],
        );
        return (res.rowCount ?? 0) > 0;
      });
    },
    async clearBought(userId, listId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE shopping_items SET status = 'removed', removed_at = now() WHERE user_id = $1 AND list_id = $2::uuid AND status = 'bought'`,
          [userId, listId],
        );
        return res.rowCount ?? 0;
      });
    },
    async markAllBought(userId, listId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE shopping_items SET status = 'bought', bought_at = now() WHERE user_id = $1 AND list_id = $2::uuid AND status = 'active'`,
          [userId, listId],
        );
        return res.rowCount ?? 0;
      });
    },
    async empty(userId, listId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE shopping_items SET status = 'removed', removed_at = now() WHERE user_id = $1 AND list_id = $2::uuid AND status <> 'removed'`,
          [userId, listId],
        );
        return res.rowCount ?? 0;
      });
    },
  };
  return repo;
}

/** Repository finto per CLI e test: una sola lista «Spesa» con le voci date, nessuna persistenza. */
export function createStubShoppingRepository(
  items: readonly ShoppingItem[] = [],
): ShoppingListRepository {
  const now = new Date();
  const list: ShoppingList = {
    id: '00000000-0000-4000-8000-000000000001',
    name: DEFAULT_LIST_NAME,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    open: items.filter((i) => i.status === 'active').length,
    bought: items.filter((i) => i.status === 'bought').length,
  };
  return {
    lists: async () => [list],
    getList: async () => list,
    createList: async (_u, name) => ({ ...list, name }),
    renameList: async (_u, _id, name) => ({ ...list, name }),
    setListStatus: async (_u, _id, status) => ({ ...list, status }),
    deleteList: async () => true,
    resolve: async () => ({ kind: 'list', list }),
    touch: async () => {},
    items: async () => [...items],
    add: async () => ({ added: [], alreadyPresent: [] }),
    remove: async () => ({ removed: [], notFound: [] }),
    setChecked: async () => ({ changed: [], notFound: [] }),
    setItemChecked: async () => null,
    removeItem: async () => true,
    clearBought: async () => 0,
    markAllBought: async () => 0,
    empty: async () => 0,
  };
}

// ---------- tool per il modello ----------

const Item = z.object({ name: z.string().min(1).max(80), quantity: z.string().max(40).optional() });
const ListRef = z
  .string()
  .max(60)
  .optional()
  .describe(
    'Nome della lista; se omesso, la lista in uso (o una scelta se ce ne sono più di una).',
  );
const ListOut = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['active', 'archived']),
  open: z.number().int(),
  bought: z.number().int(),
});
const ItemOut = z.object({
  id: z.uuid(),
  name: z.string(),
  quantity: z.string().nullable(),
  checked: z.boolean(),
});
/** Esito comune: o la lista con le voci, o una scelta tra liste (il modello chiede all'utente). */
const ListResult = z.object({
  list: ListOut.optional(),
  items: z.array(ItemOut).optional(),
  choose: z.array(ListOut).optional(),
  question: z.string().max(100).optional(),
  pendingText: z.string().max(32_000).optional(),
  message: z.string(),
});
type ListResult = z.infer<typeof ListResult>;

const outList = (l: ShoppingList) => ({
  id: l.id,
  name: l.name,
  status: l.status,
  open: l.open,
  bought: l.bought,
});
const outItems = (items: readonly ShoppingItem[]) =>
  items.map((i) => ({
    id: i.id,
    name: i.name,
    quantity: i.quantity,
    checked: i.status === 'bought',
  }));

function presentResult(out: ListResult): ContentBlock | null {
  if (out.choose?.length)
    return toChooserBlock(
      out.choose.map((l) => ({
        ...l,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        lastUsedAt: new Date(0),
      })),
      out.question,
      out.pendingText,
    );
  if (out.list && out.items)
    return {
      kind: 'shopping_list',
      listId: out.list.id,
      name: out.list.name.slice(0, 60),
      status: out.list.status,
      items: out.items.slice(0, 200).map((i) => ({
        id: i.id,
        name: i.name.slice(0, 120),
        ...(i.quantity ? { quantity: i.quantity.slice(0, 40) } : {}),
        checked: i.checked,
      })),
    };
  return null;
}

/** Tool delle liste della spesa: scritture con `write: true` (in run contaminata richiedono conferma). */
export function createShoppingTools(repo: ShoppingListRepository): ToolSpec[] {
  const write = { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true };
  const read = { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false };
  // Dopo aver chiesto una lista il modello deve attendere un nuovo turno, non rispondere da sé.
  const addTurns = new WeakMap<object, Promise<ListResult>>();
  const afterListChoice = (run: object, action: () => Promise<ListResult>): Promise<ListResult> => {
    const previous = addTurns.get(run)?.catch(() => undefined) ?? Promise.resolve(undefined);
    const result = previous.then((pending) => (pending?.choose?.length ? pending : action()));
    addTurns.set(run, result);
    return result;
  };

  const pick = async (
    userId: string,
    hint: string | undefined,
    opts?: { createDefault?: boolean; suggestExisting?: boolean },
  ): Promise<{ list: ShoppingList } | { result: ListResult }> => {
    const r = await resolveShoppingTarget(repo, userId, hint, opts);
    if (r.kind === 'list') return { list: r.list };
    if (r.kind === 'choose')
      return {
        result: {
          choose: r.lists.map(outList),
          question: shoppingChoiceQuestion(r.lists),
          message: `${shoppingChoiceQuestion(r.lists)} La scheda contiene le liste disponibili. Nessuna modifica eseguita: attendi che l'utente scelga, senza creare liste o scegliere tu.`,
        },
      };
    return {
      result: {
        message: hint
          ? `Nessuna lista chiamata «${hint}». Proponi di crearla con shopping_list_create.`
          : 'Nessuna lista: creane una con shopping_list_create.',
      },
    };
  };
  const snapshot = async (
    userId: string,
    list: ShoppingList,
    message: string,
  ): Promise<ListResult> => {
    const fresh = (await repo.getList(userId, list.id)) ?? list;
    return { list: outList(fresh), items: outItems(await repo.items(userId, list.id)), message };
  };

  const get = defineTool({
    id: 'shopping_list_get',
    version: '2',
    category: 'shopping_list',
    description:
      "Mostra una lista della spesa (voci da prendere e prese) come scheda interattiva. `list`: nome della lista; se l'utente non lo dice e ce n'è più di una, restituisce la scelta.",
    risk: read,
    timeoutMs: 5_000,
    inputSchema: z.object({ list: ListRef }),
    outputSchema: ListResult,
    execute: async ({ list }, ctx) => {
      const p = await pick(ctx.userId, list, { createDefault: true, suggestExisting: true });
      if ('result' in p) return p.result;
      await repo.touch(ctx.userId, p.list.id);
      return snapshot(ctx.userId, p.list, `Lista «${p.list.name}».`);
    },
    present: (_i, out) => presentResult(out),
  });

  const add = defineTool({
    id: 'shopping_list_add',
    version: '2',
    category: 'shopping_list',
    description:
      'Aggiunge voci (con quantità facoltativa) a una lista della spesa, solo su richiesta esplicita. `list`: nome o riferimento detto dall’utente. Se restituisce choose, la scheda permette di scegliere: attendi il tap senza creare liste o ripetere l’aggiunta su una lista scelta da te.',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({ items: z.array(Item).min(1).max(30), list: ListRef }),
    outputSchema: ListResult.extend({
      added: z.array(z.string()).optional(),
      alreadyPresent: z.array(z.string()).optional(),
    }),
    execute: async ({ items, list }, ctx) =>
      afterListChoice(ctx.run, async () => {
        const p = await pick(ctx.userId, list, { createDefault: true, suggestExisting: true });
        if ('result' in p) {
          if (!p.result.choose?.length) return p.result;
          return { ...p.result, pendingText: shoppingAddRequest(items) };
        }
        const r = await repo.add(ctx.userId, p.list.id, items, 'tool');
        const added = r.added.map((i) => i.name);
        return {
          ...(await snapshot(
            ctx.userId,
            p.list,
            `Aggiunte ${added.length} voci a «${p.list.name}»${r.alreadyPresent.length ? `; già presenti: ${r.alreadyPresent.join(', ')}` : ''}.`,
          )),
          added,
          alreadyPresent: r.alreadyPresent,
        };
      }),
    present: (_i, out) => presentResult(out),
  });

  const remove = defineTool({
    id: 'shopping_list_remove',
    version: '2',
    category: 'shopping_list',
    description: 'Toglie voci da una lista della spesa (per nome, anche parziale).',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({
      names: z.array(z.string().min(1).max(80)).min(1).max(30),
      list: ListRef,
    }),
    outputSchema: ListResult.extend({
      removed: z.array(z.string()).optional(),
      notFound: z.array(z.string()).optional(),
    }),
    execute: async ({ names, list }, ctx) => {
      const p = await pick(ctx.userId, list);
      if ('result' in p) return p.result;
      const r = await repo.remove(ctx.userId, p.list.id, names);
      return {
        ...(await snapshot(
          ctx.userId,
          p.list,
          `Tolte ${r.removed.length} voci da «${p.list.name}»${r.notFound.length ? `; non trovate: ${r.notFound.join(', ')}` : ''}.`,
        )),
        removed: r.removed,
        notFound: r.notFound,
      };
    },
    present: (_i, out) => presentResult(out),
  });

  const check = defineTool({
    id: 'shopping_list_check',
    version: '1',
    category: 'shopping_list',
    description:
      'Segna voci come prese (checked=true, es. «ho preso il latte») o le rimette da prendere (checked=false). Le voci prese restano in lista, barrate.',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({
      names: z.array(z.string().min(1).max(80)).min(1).max(30),
      checked: z.boolean().default(true),
      list: ListRef,
    }),
    outputSchema: ListResult.extend({
      changed: z.array(z.string()).optional(),
      notFound: z.array(z.string()).optional(),
    }),
    execute: async ({ names, checked, list }, ctx) => {
      const p = await pick(ctx.userId, list);
      if ('result' in p) return p.result;
      const r = await repo.setChecked(ctx.userId, p.list.id, names, checked);
      return {
        ...(await snapshot(
          ctx.userId,
          p.list,
          `${checked ? 'Prese' : 'Da riprendere'}: ${r.changed.join(', ') || 'nessuna'}${r.notFound.length ? `; non trovate: ${r.notFound.join(', ')}` : ''}.`,
        )),
        changed: r.changed,
        notFound: r.notFound,
      };
    },
    present: (_i, out) => presentResult(out),
  });

  const clear = defineTool({
    id: 'shopping_list_clear',
    version: '2',
    category: 'shopping_list',
    description:
      'Chiude la spesa di una lista: `mode` = bought segna tutte le voci come prese («ho fatto la spesa»), empty toglie tutte le voci («svuota la lista»), bought_only toglie solo le voci già prese.',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({
      mode: z.enum(['bought', 'empty', 'bought_only']).default('bought'),
      list: ListRef,
    }),
    outputSchema: ListResult.extend({ count: z.number().int().optional() }),
    execute: async ({ mode, list }, ctx) => {
      const p = await pick(ctx.userId, list);
      if ('result' in p) return p.result;
      const count =
        mode === 'bought'
          ? await repo.markAllBought(ctx.userId, p.list.id)
          : mode === 'empty'
            ? await repo.empty(ctx.userId, p.list.id)
            : await repo.clearBought(ctx.userId, p.list.id);
      return {
        ...(await snapshot(
          ctx.userId,
          p.list,
          `Fatto: ${count} voci (${mode}) in «${p.list.name}».`,
        )),
        count,
      };
    },
    present: (_i, out) => presentResult(out),
  });

  const lists = defineTool({
    id: 'shopping_lists',
    version: '1',
    category: 'shopping_list',
    description:
      "Elenca le liste della spesa dell'utente (attive e, se richiesto, archiviate) con il numero di voci; le mostra come scelta toccabile.",
    risk: read,
    timeoutMs: 5_000,
    inputSchema: z.object({ includeArchived: z.boolean().default(false) }),
    outputSchema: z.object({ lists: z.array(ListOut) }),
    execute: async ({ includeArchived }, ctx) => ({
      lists: (await repo.lists(ctx.userId, { includeArchived })).map(outList),
    }),
    present: (_i, out) =>
      out.lists.length
        ? toChooserBlock(
            out.lists.map((l) => ({
              ...l,
              createdAt: new Date(0),
              updatedAt: new Date(0),
              lastUsedAt: new Date(0),
            })),
            'Le tue liste',
          )
        : null,
  });

  const create = defineTool({
    id: 'shopping_list_create',
    version: '1',
    category: 'shopping_list',
    description:
      'Crea una nuova lista della spesa con il nome dato (es. «Natale», «Esselunga»); se esiste già la riattiva.',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({ name: z.string().min(1).max(60) }),
    outputSchema: ListResult,
    execute: async ({ name }, ctx) =>
      afterListChoice(ctx.run, async () => {
        const l = await repo.createList(ctx.userId, name);
        return snapshot(ctx.userId, l, `Lista «${l.name}» pronta.`);
      }),
    present: (_i, out) => presentResult(out),
  });

  const archive = defineTool({
    id: 'shopping_list_archive',
    version: '1',
    category: 'shopping_list',
    description: 'Archivia una lista (resta richiamabile) oppure la ripristina (`restore: true`).',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({ list: z.string().min(1).max(60), restore: z.boolean().default(false) }),
    outputSchema: ListResult,
    execute: async ({ list, restore }, ctx) => {
      const p = await pick(ctx.userId, list);
      if ('result' in p) return p.result;
      const l = await repo.setListStatus(ctx.userId, p.list.id, restore ? 'active' : 'archived');
      if (!l) throw new ToolError('lista non trovata', 'not_found');
      return snapshot(
        ctx.userId,
        l,
        `Lista «${l.name}» ${restore ? 'ripristinata' : 'archiviata'}.`,
      );
    },
    present: (_i, out) => presentResult(out),
  });

  const rename = defineTool({
    id: 'shopping_list_rename',
    version: '1',
    category: 'shopping_list',
    description: 'Rinomina una lista della spesa.',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({ list: z.string().min(1).max(60), name: z.string().min(1).max(60) }),
    outputSchema: ListResult,
    execute: async ({ list, name }, ctx) => {
      const p = await pick(ctx.userId, list);
      if ('result' in p) return p.result;
      const l = await repo.renameList(ctx.userId, p.list.id, name);
      if (!l) throw new ToolError('lista non trovata', 'not_found');
      return snapshot(ctx.userId, l, `Lista rinominata in «${l.name}».`);
    },
    present: (_i, out) => presentResult(out),
  });

  const del = defineTool({
    id: 'shopping_list_delete',
    version: '1',
    category: 'shopping_list',
    description:
      'Elimina definitivamente una lista della spesa con le sue voci (chiedi conferma prima).',
    risk: write,
    timeoutMs: 5_000,
    inputSchema: z.object({ list: z.string().min(1).max(60) }),
    outputSchema: z.object({
      deleted: z.boolean(),
      name: z.string().optional(),
      choose: z.array(ListOut).optional(),
      message: z.string(),
    }),
    execute: async ({ list }, ctx) => {
      const p = await pick(ctx.userId, list);
      if ('result' in p)
        return { deleted: false, choose: p.result.choose, message: p.result.message };
      const ok = await repo.deleteList(ctx.userId, p.list.id);
      return {
        deleted: ok,
        name: p.list.name,
        message: ok ? `Lista «${p.list.name}» eliminata.` : 'Lista non trovata.',
      };
    },
  });

  return [get, add, remove, check, clear, lists, create, archive, rename, del];
}
