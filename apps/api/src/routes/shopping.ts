import type { ShoppingListRepository } from '@ernie/tools';
import { toShoppingBlock } from '@ernie/tools';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface ShoppingRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly repo: ShoppingListRepository;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const Uuid = z.uuid();
const ListPatch = z
  .object({
    name: z.string().min(1).max(60).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((b) => b.name !== undefined || b.status !== undefined, {
    message: 'atteso name o status',
  });
const ItemBody = z.object({
  name: z.string().min(1).max(80),
  quantity: z.string().max(40).optional(),
});
const ItemPatch = z.object({ checked: z.boolean() });

/**
 * Scheda interattiva della lista della spesa (protocollo v1.4): ogni azione restituisce il blocco aggiornato,
 * così la scheda nell'app resta allineata al server senza passare dal modello.
 */
export async function shoppingRoutes(
  app: FastifyInstance,
  opts: ShoppingRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  const repo = opts.repo;

  const block = async (userId: string, listId: string, reply: FastifyReply) => {
    const list = await repo.getList(userId, listId);
    if (!list) return reply.code(404).send({ error: 'not_found', message: 'lista inesistente' });
    return { block: toShoppingBlock(list, await repo.items(userId, listId)) };
  };
  const listId = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const id = (req.params as { id: string }).id;
    if (!Uuid.safeParse(id).success) {
      void reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      return null;
    }
    return id;
  };

  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/shopping/lists', async (req) => {
      const auth = requireAuth(req);
      const q = (req.query as { archived?: string }) ?? {};
      return { lists: await repo.lists(auth.userId, { includeArchived: q.archived === '1' }) };
    });

    api.post('/v1/shopping/lists', async (req, reply) => {
      const auth = requireAuth(req);
      const b = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'atteso { name }' });
      const list = await repo.createList(auth.userId, b.data.name);
      return reply.code(201).send(await block(auth.userId, list.id, reply));
    });

    api.get('/v1/shopping/lists/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      await repo.touch(auth.userId, id);
      return block(auth.userId, id, reply);
    });

    api.patch('/v1/shopping/lists/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      const b = ListPatch.safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'atteso { name?, status? }' });
      if (b.data.name !== undefined && !(await repo.renameList(auth.userId, id, b.data.name)))
        return reply.code(404).send({ error: 'not_found', message: 'lista inesistente' });
      if (
        b.data.status !== undefined &&
        !(await repo.setListStatus(auth.userId, id, b.data.status))
      )
        return reply.code(404).send({ error: 'not_found', message: 'lista inesistente' });
      return block(auth.userId, id, reply);
    });

    api.delete('/v1/shopping/lists/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      const ok = await repo.deleteList(auth.userId, id);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: 'lista inesistente' });
      return reply.code(204).send();
    });

    api.post('/v1/shopping/lists/:id/items', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      const b = ItemBody.safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'atteso { name, quantity? }' });
      await repo.add(auth.userId, id, [b.data], 'app');
      return block(auth.userId, id, reply);
    });

    api.patch('/v1/shopping/lists/:id/items/:itemId', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      const itemId = (req.params as { itemId: string }).itemId;
      if (!Uuid.safeParse(itemId).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id voce non valido' });
      const b = ItemPatch.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'atteso { checked }' });
      const item = await repo.setItemChecked(auth.userId, id, itemId, b.data.checked);
      if (!item) return reply.code(404).send({ error: 'not_found', message: 'voce inesistente' });
      await repo.touch(auth.userId, id);
      return block(auth.userId, id, reply);
    });

    api.delete('/v1/shopping/lists/:id/items/:itemId', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      const itemId = (req.params as { itemId: string }).itemId;
      if (!Uuid.safeParse(itemId).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id voce non valido' });
      const ok = await repo.removeItem(auth.userId, id, itemId);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: 'voce inesistente' });
      return block(auth.userId, id, reply);
    });

    api.post('/v1/shopping/lists/:id/clear-bought', async (req, reply) => {
      const auth = requireAuth(req);
      const id = listId(req, reply);
      if (!id) return;
      await repo.clearBought(auth.userId, id);
      return block(auth.userId, id, reply);
    });
  });
}
