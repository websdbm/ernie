import type { ShoppingListRepository } from '@ernie/tools';
import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from './registry.js';
import {
  createShoppingListSkill,
  parseItem,
  parseShoppingCommand,
  splitItems,
} from './shopping.js';

describe('parseShoppingCommand', () => {
  it('riconosce aggiunte con quantità e congiunzioni', () => {
    expect(parseShoppingCommand('aggiungi il latte alla lista della spesa')).toEqual({
      op: 'add',
      items: [{ name: 'latte' }],
    });
    expect(parseShoppingCommand('Metti due litri di latte e lo yogurt nella lista')).toEqual({
      op: 'add',
      items: [{ name: 'latte', quantity: 'due litri' }, { name: 'yogurt' }],
    });
    expect(parseShoppingCommand('segna che devo comprare le pile e 2 kg di pasta')).toEqual({
      op: 'add',
      items: [{ name: 'pile' }, { name: 'pasta', quantity: '2 kg' }],
    });
    expect(
      parseShoppingCommand('mi servono le uova, il guanciale e il pecorino per la spesa'),
    ).toEqual({
      op: 'add',
      items: [{ name: 'uova' }, { name: 'guanciale' }, { name: 'pecorino' }],
    });
  });

  it('riconosce rimozioni, lettura e svuotamento', () => {
    expect(parseShoppingCommand('togli il pane dalla lista')).toEqual({
      op: 'remove',
      names: ['pane'],
    });
    expect(parseShoppingCommand("cosa c'è nella lista della spesa?")).toEqual({ op: 'list' });
    expect(parseShoppingCommand('leggimi la lista')).toEqual({ op: 'list' });
    expect(parseShoppingCommand('Ho fatto la spesa!')).toEqual({ op: 'clear' });
    expect(parseShoppingCommand('svuota la lista')).toEqual({ op: 'empty' });
  });

  it('riconosce nomi di lista, spunte e operazioni sulle liste', () => {
    expect(parseShoppingCommand('togli il pane dalla lista Esselunga')).toEqual({
      op: 'remove',
      names: ['pane'],
      list: 'Esselunga',
    });
    expect(parseShoppingCommand('mostrami la lista di Natale')).toEqual({
      op: 'list',
      list: 'Natale',
    });
    expect(parseShoppingCommand('lista Esselunga')).toEqual({ op: 'list', list: 'Esselunga' });
    expect(parseShoppingCommand('ho preso il latte e le uova')).toEqual({
      op: 'check',
      names: ['latte', 'uova'],
      checked: true,
    });
    expect(parseShoppingCommand('spunta il pane nella lista Casa')).toEqual({
      op: 'check',
      names: ['pane'],
      checked: true,
      list: 'Casa',
    });
    expect(parseShoppingCommand('non ho preso il latte')).toEqual({
      op: 'check',
      names: ['latte'],
      checked: false,
    });
    expect(parseShoppingCommand('crea una lista chiamata Natale')).toEqual({
      op: 'create',
      name: 'Natale',
    });
    expect(parseShoppingCommand('nuova lista Esselunga')).toEqual({
      op: 'create',
      name: 'Esselunga',
    });
    expect(parseShoppingCommand('quali liste ho?')).toEqual({ op: 'lists' });
    expect(parseShoppingCommand('archivia la lista Natale')).toEqual({
      op: 'archive',
      list: 'Natale',
    });
    expect(parseShoppingCommand('riprendi la lista Natale')).toEqual({
      op: 'restore',
      list: 'Natale',
    });
    expect(parseShoppingCommand('elimina la lista Natale')).toEqual({
      op: 'delete',
      list: 'Natale',
    });
    expect(parseShoppingCommand('cancella il latte dalla lista')).toEqual({
      op: 'remove',
      names: ['latte'],
    });
    expect(parseShoppingCommand('rinomina la lista Spesa in Casa')).toEqual({
      op: 'rename',
      from: 'Spesa',
      to: 'Casa',
    });
    expect(parseShoppingCommand('ho fatto la spesa nella lista Esselunga')).toEqual({
      op: 'clear',
      list: 'Esselunga',
    });
  });

  it('non cattura richieste che non riguardano la lista', () => {
    expect(parseShoppingCommand('cosa cucino stasera?')).toBeNull();
    expect(parseShoppingCommand('mi servono le cose per la carbonara')).toBeNull();
    expect(parseShoppingCommand('quanto ho speso in spesa questo mese?')).toBeNull();
    expect(splitItems('latte, pane e uova')).toEqual(['latte', 'pane', 'uova']);
    expect(parseItem('una bottiglia di olio')).toEqual({ name: 'olio', quantity: 'una bottiglia' });
  });
});

describe('shopping skill + registry', () => {
  const now = new Date();
  const spesa = {
    id: 'l1',
    name: 'Spesa',
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    open: 1,
    bought: 0,
  };
  const natale = { ...spesa, id: 'l2', name: 'Natale', open: 0 };
  let lists = [spesa];
  const item = (
    name: string,
    quantity: string | null = null,
    status: 'active' | 'bought' = 'active',
  ) => ({
    id: `i-${name}`,
    listId: 'l1',
    name,
    quantity,
    status,
    addedAt: now,
    boughtAt: null,
  });
  const repo: ShoppingListRepository = {
    lists: vi.fn(async () => lists),
    getList: vi.fn(async (_u: string, id: string) => lists.find((l) => l.id === id) ?? null),
    createList: vi.fn(async (_u: string, name: string) => ({ ...spesa, id: `new-${name}`, name })),
    renameList: vi.fn(async (_u: string, id: string, name: string) => ({ ...spesa, id, name })),
    setListStatus: vi.fn(async (_u: string, id: string, status: 'active' | 'archived') => ({
      ...spesa,
      id,
      status,
    })),
    deleteList: vi.fn(async () => true),
    resolve: vi.fn(async (_u: string, hint?: string | null) => {
      if (hint) {
        const found = lists.filter((l) => l.name.toLowerCase().includes(hint.toLowerCase()));
        return found.length === 1 && found[0]
          ? { kind: 'list' as const, list: found[0] }
          : { kind: 'none' as const };
      }
      return lists.length === 1 && lists[0]
        ? { kind: 'list' as const, list: lists[0] }
        : { kind: 'choose' as const, lists };
    }),
    touch: vi.fn(async () => {}),
    items: vi.fn(async () => [item('latte', '2 l')]),
    add: vi.fn(
      async (
        _u: string,
        _l: string,
        items: ReadonlyArray<{ name: string; quantity?: string | null | undefined }>,
      ) => ({
        added: items.map((i) => item(i.name, i.quantity ?? null)),
        alreadyPresent: [] as string[],
      }),
    ),
    remove: vi.fn(async (_u: string, _l: string, names: readonly string[]) => ({
      removed: [...names],
      notFound: [] as string[],
    })),
    setChecked: vi.fn(async (_u: string, _l: string, names: readonly string[]) => ({
      changed: [...names],
      notFound: [] as string[],
    })),
    setItemChecked: vi.fn(async () => null),
    removeItem: vi.fn(async () => true),
    clearBought: vi.fn(async () => 0),
    markAllBought: vi.fn(async () => 1),
    empty: vi.fn(async () => 1),
  };
  const registry = new SkillRegistry().register(createShoppingListSkill(repo));
  const ctx = { userId: 'u', sessionId: null, requestId: 'r' };

  it('match + run senza modelli, con una sola lista', async () => {
    lists = [spesa];
    const m = registry.match('aggiungi il latte e le uova alla lista');
    expect(m?.skill.id).toBe('shopping_list');
    const reply = await m?.skill.run(m.plan, ctx);
    expect(reply?.text).toBe('Aggiunto latte e uova alla lista «Spesa».');
    expect(reply?.actions).toEqual(['add:latte', 'add:uova']);
    expect(reply?.blocks?.[0]?.kind).toBe('shopping_list');
    const l = registry.match("cosa c'è nella lista?");
    expect((await l?.skill.run(l.plan, ctx))?.text).toContain('2 l latte');
    const c = registry.match('ho preso il latte');
    expect((await c?.skill.run(c.plan, ctx))?.text).toBe('Segnato come preso: latte.');
    expect(registry.match('raccontami una barzelletta')).toBeNull();
  });

  it('con più liste e senza nome chiede di scegliere; con il nome trova la lista', async () => {
    lists = [spesa, natale];
    const m = registry.match('aggiungi le candele alla lista');
    const reply = await m?.skill.run(m.plan, ctx);
    expect(reply?.text).toBe('Quale lista? Tocca una lista.');
    expect(reply?.blocks?.[0]).toMatchObject({
      kind: 'shopping_lists',
      pendingText: 'aggiungi candele nella lista {lista}',
    });
    const n = registry.match('aggiungi le candele nella lista Natale');
    expect(n?.plan).toEqual({ op: 'add', items: [{ name: 'candele' }], list: 'Natale' });
    expect((await n?.skill.run(n.plan, ctx))?.text).toBe('Aggiunto candele alla lista «Natale».');
    const k = registry.match('quali liste ho?');
    const kr = await k?.skill.run(k.plan, ctx);
    expect(kr?.blocks?.[0]?.kind).toBe('shopping_lists');
    const a = registry.match('archivia la lista Natale');
    expect((await a?.skill.run(a.plan, ctx))?.text).toContain('archiviata');
  });

  it('candidate per Jev per sovrapposizione lessicale', () => {
    expect(registry.candidates('mi servono le cose per la spesa')).toEqual(['shopping_list']);
    expect(registry.candidates('che tempo fa domani')).toEqual([]);
  });
});

describe('apostrofo tipografico', () => {
  it('riconosce le frasi scritte con ’ (tastiere mobili) come quelle con l’apostrofo ASCII', () => {
    expect(parseShoppingCommand('cosa c’è nella lista della spesa?')).toEqual({ op: 'list' });
    expect(parseShoppingCommand("cosa c'è nella lista della spesa?")).toEqual({ op: 'list' });
  });
});

describe('spesa: impegni e frasi che non sono voci (revisione del 16 ott 2026)', () => {
  it('orari, persone e luoghi non finiscono nella lista; le voci restano', async () => {
    const { parseShoppingCommand, describeShoppingPlan } = await import('./shopping.js');
    expect(parseShoppingCommand('devo prendere le medicine alle 20')).toBeNull();
    expect(parseShoppingCommand('devo prendere Giorgio a scuola')).toBeNull();
    expect(parseShoppingCommand('devo prendere il pane e il latte')).toMatchObject({ op: 'add' });
    const plan = parseShoppingCommand('ho preso freddo');
    // La frase è ancora riconosciuta come spunta, ma il controllo di Jev vede cosa farebbe.
    expect(plan ? describeShoppingPlan(plan) : null).toBe(
      'segna come già presi nella lista della spesa: freddo',
    );
  });
});
