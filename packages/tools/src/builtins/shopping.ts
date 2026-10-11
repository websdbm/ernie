import { type Pool, withUser } from '@ernie/db';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

export interface ShoppingItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: string | null;
  readonly status: 'active' | 'bought' | 'removed';
  readonly addedAt: Date;
}

export function normalizeItemName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ShoppingListRepository {
  add(
    userId: string,
    items: ReadonlyArray<{ name: string; quantity?: string | null | undefined }>,
    source?: string,
  ): Promise<{ added: ShoppingItem[]; alreadyPresent: string[] }>;
  remove(
    userId: string,
    names: readonly string[],
  ): Promise<{ removed: string[]; notFound: string[] }>;
  list(userId: string): Promise<ShoppingItem[]>;
  markAllBought(userId: string): Promise<number>;
}

interface Row {
  id: string;
  name: string;
  quantity: string | null;
  status: ShoppingItem['status'];
  added_at: Date;
}
const toItem = (r: Row): ShoppingItem => ({
  id: r.id,
  name: r.name,
  quantity: r.quantity,
  status: r.status,
  addedAt: r.added_at,
});

export function createShoppingListRepository(pool: Pool): ShoppingListRepository {
  return {
    async add(userId, items, source = 'user') {
      return withUser(pool, userId, async (client) => {
        const added: ShoppingItem[] = [];
        const alreadyPresent: string[] = [];
        for (const it of items) {
          const name = it.name.trim();
          if (!name) continue;
          const norm = normalizeItemName(name);
          const res = await client.query<Row>(
            `INSERT INTO shopping_items (user_id, name, name_norm, quantity, source, added_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())
             ON CONFLICT (user_id, name_norm) WHERE status = 'active' DO NOTHING
             RETURNING id, name, quantity, status, added_at`,
            [userId, name, norm, it.quantity ?? null, source],
          );
          const row = res.rows[0];
          if (row) added.push(toItem(row));
          else {
            if (it.quantity)
              await client.query(
                `UPDATE shopping_items SET quantity = $3 WHERE user_id = $1 AND name_norm = $2 AND status = 'active'`,
                [userId, norm, it.quantity],
              );
            alreadyPresent.push(name);
          }
        }
        return { added, alreadyPresent };
      });
    },
    async remove(userId, names) {
      return withUser(pool, userId, async (client) => {
        const removed: string[] = [];
        const notFound: string[] = [];
        for (const n of names) {
          const norm = normalizeItemName(n);
          const res = await client.query<{ name: string }>(
            `UPDATE shopping_items SET status = 'removed', removed_at = now() WHERE user_id = $1 AND status = 'active' AND (name_norm = $2 OR name_norm LIKE $3) RETURNING name`,
            [userId, norm, `%${norm}%`],
          );
          if (res.rowCount) removed.push(...res.rows.map((r) => r.name));
          else notFound.push(n);
        }
        return { removed, notFound };
      });
    },
    async list(userId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query<Row>(
          `SELECT id, name, quantity, status, added_at FROM shopping_items WHERE user_id = $1 AND status = 'active' ORDER BY added_at`,
          [userId],
        );
        return res.rows.map(toItem);
      });
    },
    async markAllBought(userId) {
      return withUser(pool, userId, async (client) => {
        const res = await client.query(
          `UPDATE shopping_items SET status = 'bought', bought_at = now() WHERE user_id = $1 AND status = 'active'`,
          [userId],
        );
        return res.rowCount ?? 0;
      });
    },
  };
}

const Item = z.object({ name: z.string().min(1).max(80), quantity: z.string().max(40).optional() });
const ItemOut = z.object({ name: z.string(), quantity: z.string().nullable() });

/** Tool della lista della spesa: scritture con `write: true` (in run contaminata richiedono conferma). */
export function createShoppingTools(repo: ShoppingListRepository): ToolSpec[] {
  const base = { version: '1', category: 'shopping_list', timeoutMs: 5_000 } as const;
  return [
    defineTool({
      ...base,
      id: 'shopping_list_add',
      description: 'Aggiunge una o più voci alla lista della spesa (con quantità opzionale).',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      inputSchema: z.object({ items: z.array(Item).min(1).max(30) }),
      outputSchema: z.object({ added: z.array(ItemOut), alreadyPresent: z.array(z.string()) }),
      execute: async ({ items }, ctx) => {
        const r = await repo.add(ctx.userId, items, 'assistant');
        return {
          added: r.added.map((i) => ({ name: i.name, quantity: i.quantity })),
          alreadyPresent: r.alreadyPresent,
        };
      },
    }),
    defineTool({
      ...base,
      id: 'shopping_list_remove',
      description: 'Toglie una o più voci dalla lista della spesa.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      inputSchema: z.object({ names: z.array(z.string().min(1).max(80)).min(1).max(30) }),
      outputSchema: z.object({ removed: z.array(z.string()), notFound: z.array(z.string()) }),
      execute: async ({ names }, ctx) => repo.remove(ctx.userId, names),
    }),
    defineTool({
      ...base,
      id: 'shopping_list_get',
      description: 'Legge la lista della spesa corrente.',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      inputSchema: z.object({}),
      outputSchema: z.object({ items: z.array(ItemOut), count: z.number().int() }),
      execute: async (_i, ctx) => {
        const items = await repo.list(ctx.userId);
        return {
          items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
          count: items.length,
        };
      },
    }),
    defineTool({
      ...base,
      id: 'shopping_list_clear',
      description: 'Segna tutta la lista come comprata (spesa fatta).',
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
      inputSchema: z.object({}),
      outputSchema: z.object({ bought: z.number().int() }),
      execute: async (_i, ctx) => ({ bought: await repo.markAllBought(ctx.userId) }),
    }),
  ];
}
