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
    expect(parseShoppingCommand('svuota la lista')).toEqual({ op: 'clear' });
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
  const repo: ShoppingListRepository = {
    add: vi.fn(
      async (
        _u: string,
        items: ReadonlyArray<{ name: string; quantity?: string | null | undefined }>,
      ) => ({
        added: items.map((i, k: number) => ({
          id: String(k),
          name: i.name,
          quantity: i.quantity ?? null,
          status: 'active' as const,
          addedAt: new Date(),
        })),
        alreadyPresent: [] as string[],
      }),
    ),
    remove: vi.fn(async (_u: string, names: readonly string[]) => ({
      removed: [...names],
      notFound: [] as string[],
    })),
    list: vi.fn(async () => [
      { id: '1', name: 'latte', quantity: '2 l', status: 'active' as const, addedAt: new Date() },
    ]),
    markAllBought: vi.fn(async () => 1),
  };
  const registry = new SkillRegistry().register(createShoppingListSkill(repo));
  const ctx = { userId: 'u', sessionId: null, requestId: 'r' };

  it('match + run senza modelli', async () => {
    const m = registry.match('aggiungi il latte e le uova alla lista');
    expect(m?.skill.id).toBe('shopping_list');
    const reply = await m?.skill.run(m.plan, ctx);
    expect(reply?.text).toBe('Aggiunto latte e uova alla lista.');
    expect(reply?.actions).toEqual(['add:latte', 'add:uova']);
    const l = registry.match("cosa c'è nella lista?");
    expect((await l?.skill.run(l.plan, ctx))?.text).toContain('2 l latte');
    expect(registry.match('raccontami una barzelletta')).toBeNull();
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
