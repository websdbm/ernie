import { randomUUID } from 'node:crypto';
import { RunContext } from '@ernie/agent-core';
import { ContentBlock } from '@ernie/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createShoppingTools,
  createStubShoppingRepository,
  type ShoppingList,
  type ShoppingListRepository,
  toChooserBlock,
} from './builtins/shopping.js';

const list = (name: string): ShoppingList => ({
  id: randomUUID(),
  name,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  lastUsedAt: new Date(),
  open: 1,
  bought: 0,
});
const context = () => ({
  userId: 'owner',
  sessionId: 'session',
  requestId: randomUUID(),
  scopes: ['chat'],
  run: new RunContext('owner', ['chat'], 0),
});

describe('shopping tool closed choices', () => {
  it('an unmatched name proposes active lists and preserves the original addition through model retries', async () => {
    const spesa = list('Spesa'),
      casa = list('Casa');
    const repo = createStubShoppingRepository();
    repo.lists = vi.fn<ShoppingListRepository['lists']>(async () => [
      spesa,
      casa,
      { ...list('Viaggio'), status: 'archived' },
    ]);
    repo.resolve = vi.fn<ShoppingListRepository['resolve']>(async (_user, hint) =>
      hint === spesa.name ? { kind: 'list', list: spesa } : { kind: 'none' },
    );
    repo.getList = vi.fn(async () => spesa);
    repo.add = vi.fn(async () => ({ added: [], alreadyPresent: [] }));
    repo.createList = vi.fn(async () => list('Inattesa'));
    const tools = createShoppingTools(repo);
    const add = tools.find((t) => t.id === 'shopping_list_add');
    const create = tools.find((t) => t.id === 'shopping_list_create');
    if (!add || !create) throw new Error('Missing shopping tools');
    const ctx = context();
    const input = { list: 'cose da acquistare', items: [{ name: 'miele', quantity: '2 vasetti' }] };
    const output = add.outputSchema.parse(await add.execute(input, ctx));
    expect(repo.lists).toHaveBeenCalledWith('owner');
    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.createList).not.toHaveBeenCalled();
    const block = ContentBlock.parse(add.present?.(input, output));
    if (block.kind !== 'shopping_lists') throw new Error('Missing chooser');
    expect(block.lists.map((l) => l.name)).toEqual(['Spesa', 'Casa']);
    expect(block).toMatchObject({
      kind: 'shopping_lists',
      pendingText: 'aggiungi 2 vasetti miele nella lista «{lista}»',
    });
    // The LLM cannot resolve its own question in this turn, even with changed arguments.
    const retry = await add.execute({ list: 'Spesa', items: [{ name: 'altro' }] }, ctx);
    expect(retry).toEqual(output);
    expect(await create.execute({ name: 'cose da acquistare' }, ctx)).toEqual(output);
    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.createList).not.toHaveBeenCalled();
    const parallel = context();
    const concurrent = await Promise.all([
      add.execute(input, parallel),
      add.execute({ ...input, list: 'Spesa' }, parallel),
      create.execute({ name: 'cose da acquistare' }, parallel),
    ]);
    expect(concurrent).toEqual([output, output, output]);
    expect(repo.add).not.toHaveBeenCalled();
    expect(repo.createList).not.toHaveBeenCalled();
    await add.execute({ ...input, list: 'Spesa' }, context());
    expect(repo.add).toHaveBeenCalledExactlyOnceWith('owner', spesa.id, input.items, 'tool');
  });

  it('tool choices keep batches longer than 500 characters intact, including the last item', async () => {
    const spesa = list('Spesa');
    const repo = createStubShoppingRepository();
    repo.resolve = async () => ({ kind: 'choose', lists: [spesa] });
    const add = createShoppingTools(repo).find((t) => t.id === 'shopping_list_add');
    if (!add) throw new Error('Missing shopping tool');
    const input = {
      items: Array.from({ length: 30 }, (_, i) => ({
        name: `Prodotto numero ${i} per la dispensa`,
        quantity: '2 confezioni',
      })),
    };
    const output = add.outputSchema.parse(await add.execute(input, context()));
    const block = ContentBlock.parse(add.present?.(input, output));
    if (block.kind !== 'shopping_lists') throw new Error('Missing chooser');
    expect(block.pendingText?.length).toBeGreaterThan(500);
    for (const item of input.items)
      expect(block.pendingText).toContain(`${item.quantity} ${item.name}`);
    expect(block.pendingText).toContain('nella lista «{lista}»');
  });

  it('oversized requests reference the original instead of silently truncating products', () => {
    const block = ContentBlock.parse(
      toChooserBlock([list('Spesa')], 'Quale lista?', 'x'.repeat(32_001)),
    );
    expect(block).toMatchObject({
      pendingText: 'Usa la lista «{lista}» per completare la mia richiesta precedente.',
    });
  });
});
