import type { ShoppingListRepository } from '@ernie/tools';
import type { DeterministicSkill, SkillReply } from './types.js';

export type ShoppingPlan =
  | { op: 'add'; items: Array<{ name: string; quantity?: string }> }
  | { op: 'remove'; names: string[] }
  | { op: 'list' }
  | { op: 'clear' };

const LIST = String.raw`(?:(?:la|alla|nella|dalla|sulla|in|dalla mia|alla mia|nella mia)\s+)?lista(?:\s+della\s+spesa)?`;
const QUANTITY =
  /^(?<q>(?:\d+(?:[.,]\d+)?|un|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|mezzo|mezza)\s*(?:kg|g|l|litri?|litro|etti?|grammi?|chili?|chilo|pacchi?|pacco|confezioni?|confezione|bottiglie?|bottiglia|vasetti?|vasetto|scatole?|scatola|pezzi?)?)\s+(?:di\s+)?(?<n>.+)$/i;

export function splitItems(text: string): string[] {
  return text
    .replace(/\s+(e|ed)\s+/gi, ',')
    .split(/\s*[,;]\s*/)
    .map((s) =>
      s
        .trim()
        .replace(/^(il|lo|la|i|gli|le|l'|un|uno|una|del|della|dello|dei|degli|delle)\s+/i, '')
        .trim(),
    )
    .filter((s) => s.length > 0 && s.length <= 80);
}

export function parseItem(raw: string): { name: string; quantity?: string } {
  const m = QUANTITY.exec(raw.trim());
  if (m?.groups?.n && m.groups.q) {
    const name = m.groups.n.replace(/^(il|lo|la|i|gli|le|l')\s+/i, '').trim();
    return { name, quantity: m.groups.q.trim() };
  }
  return { name: raw.trim() };
}

/** Riconosce le richieste sulla lista della spesa in italiano; null se non è una richiesta di questo tipo. */
export function parseShoppingCommand(input: string): ShoppingPlan | null {
  // Le tastiere mobili scrivono l'apostrofo tipografico (’): normalizzato prima di qualunque regola.
  const text = input
    .replace(/[\u2018\u2019\u00B4`]/gu, "'")
    .trim()
    .replace(/[.!?]+$/gu, '')
    .trim();
  const lower = text.toLowerCase();
  if (!/lista|spesa|comprare|prendere/u.test(lower)) return null;

  if (
    /^(ho fatto la spesa|spesa fatta|svuota|azzera|pulisci)(?=\s|$)/u.test(lower) ||
    /(svuota|azzera)\s+(la\s+)?lista/u.test(lower)
  ) {
    return { op: 'clear' };
  }

  const listPatterns = [
    /^(cosa|cos'|che|che cosa)\s*(c'è|c è|c'e|ce|è|ho)(?=\s|$).*lista/u,
    /^(leggi|leggimi|mostra|mostrami|dimmi|fammi vedere|apri|vedi)(?=\s|$).*lista/u,
    /^lista(\s+della\s+spesa)?$/u,
    /la lista (è|e')\s+aggiornata/u,
  ];
  if (listPatterns.some((re) => re.test(lower))) return { op: 'list' };

  const remove = new RegExp(
    String.raw`^(?:togli(?:mi)?|rimuovi|cancella|elimina|leva)\s+(?<items>.+?)\s+(?:${LIST})$`,
    'iu',
  );
  const rm = remove.exec(text);
  if (rm?.groups?.items) return { op: 'remove', names: splitItems(rm.groups.items) };

  const add = new RegExp(
    String.raw`^(?:aggiungi(?:mi)?|metti(?:mi)?|inserisci|segna(?:mi)?)\s+(?<items>.+?)\s+(?:${LIST})$`,
    'iu',
  );
  const ad = add.exec(text);
  if (ad?.groups?.items) return { op: 'add', items: splitItems(ad.groups.items).map(parseItem) };

  const need =
    /^(?:segna(?:mi)? che )?(?:devo|dobbiamo|mi serve|mi servono|ci serve|ci servono|ricordami di)\s+(?:(?:comprare|prendere)\s+)?(?<items>.+?)(?:\s+(?:per|alla|nella|in)\s+(?:la\s+)?(?:spesa|lista(?:\s+della\s+spesa)?))?$/iu;
  const nd = need.exec(text);
  if (nd?.groups?.items && !/\b(cose|roba|ingredienti)\s+per\b/iu.test(nd.groups.items)) {
    return { op: 'add', items: splitItems(nd.groups.items).map(parseItem) };
  }

  return null;
}

function joinIt(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

export function createShoppingListSkill(repo: ShoppingListRepository): DeterministicSkill {
  return {
    id: 'shopping_list',
    kind: 'deterministic',
    category: 'shopping_list',
    description: 'Aggiunge, toglie, legge o svuota la lista della spesa su richiesta esplicita.',
    examples: [
      'aggiungi il latte alla lista',
      'togli il pane dalla lista',
      "cosa c'è nella lista della spesa?",
      'ho fatto la spesa',
      'mi servono due litri di latte e lo yogurt',
    ],
    match: (text) => parseShoppingCommand(text),
    run: async (plan, ctx): Promise<SkillReply> => {
      const p = plan as ShoppingPlan;
      switch (p.op) {
        case 'add': {
          const r = await repo.add(ctx.userId, p.items, 'skill');
          const added = r.added.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));
          const parts: string[] = [];
          if (added.length) parts.push(`Aggiunto ${joinIt(added)} alla lista.`);
          if (r.alreadyPresent.length)
            parts.push(
              `${joinIt(r.alreadyPresent)} ${r.alreadyPresent.length > 1 ? 'erano' : 'era'} già in lista.`,
            );
          return {
            text: parts.join(' ') || 'Non ho capito cosa aggiungere.',
            actions: added.map((a) => `add:${a}`),
          };
        }
        case 'remove': {
          const r = await repo.remove(ctx.userId, p.names);
          const parts: string[] = [];
          if (r.removed.length) parts.push(`Tolto ${joinIt(r.removed)} dalla lista.`);
          if (r.notFound.length)
            parts.push(
              `${joinIt(r.notFound)} non ${r.notFound.length > 1 ? 'erano' : 'era'} in lista.`,
            );
          return { text: parts.join(' '), actions: r.removed.map((n) => `remove:${n}`) };
        }
        case 'list': {
          const items = await repo.list(ctx.userId);
          if (items.length === 0)
            return { text: 'La lista della spesa è vuota.', actions: ['list'] };
          const names = items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));
          return {
            text: `In lista ${items.length === 1 ? "c'è" : 'ci sono'} ${items.length} ${items.length === 1 ? 'voce' : 'voci'}: ${joinIt(names)}.`,
            actions: ['list'],
          };
        }
        case 'clear': {
          const n = await repo.markAllBought(ctx.userId);
          return {
            text:
              n > 0
                ? `Segnate come comprate ${n} ${n === 1 ? 'voce' : 'voci'}. Lista svuotata.`
                : 'La lista era già vuota.',
            actions: [`clear:${n}`],
          };
        }
        default:
          return { text: 'Richiesta non riconosciuta.', actions: [] };
      }
    },
  };
}
