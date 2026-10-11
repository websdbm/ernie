import {
  type ShoppingList,
  type ShoppingListRepository,
  toChooserBlock,
  toShoppingBlock,
} from '@ernie/tools';
import type { DeterministicSkill, SkillReply } from './types.js';

/**
 * Liste della spesa multiple, a parole (nessun modello): «aggiungi il latte alla lista Esselunga», «ho preso il
 * latte», «crea una lista Natale», «archivia la lista Esselunga», «quali liste ho?». Il nome della lista è
 * facoltativo: con una sola lista attiva (o una usata da poco) si usa quella, altrimenti si chiede con una
 * scheda di scelta e l'app rimanda la frase con il nome scelto.
 */
export type ShoppingPlan =
  | { op: 'add'; items: Array<{ name: string; quantity?: string }>; list?: string }
  | { op: 'remove'; names: string[]; list?: string }
  | { op: 'check'; names: string[]; checked: boolean; list?: string }
  | { op: 'list'; list?: string }
  | { op: 'clear'; list?: string }
  | { op: 'empty'; list?: string }
  | { op: 'lists' }
  | { op: 'create'; name: string }
  | { op: 'archive'; list?: string }
  | { op: 'restore'; list: string }
  | { op: 'delete'; list: string }
  | { op: 'rename'; from: string; to: string };

const LIST = String.raw`(?:(?:la|alla|nella|dalla|sulla|in|dalla mia|alla mia|nella mia)\s+)?lista(?:\s+della\s+spesa)?`;
const QUANTITY =
  /^(?<q>(?:\d+(?:[.,]\d+)?|un|uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|mezzo|mezza)\s*(?:kg|g|l|litri?|litro|etti?|grammi?|chili?|chilo|pacchi?|pacco|confezioni?|confezione|bottiglie?|bottiglia|vasetti?|vasetto|scatole?|scatola|pezzi?)?)\s+(?:di\s+)?(?<n>.+)$/i;
/** Nome della lista in coda alla frase: «… nella lista Esselunga», «… alla lista di Natale», «… lista «Casa»». */
const LIST_HINT =
  /\s+(?:nella|alla|dalla|sulla|in|nel|per la|della|la)\s+lista\s+(?:della\s+spesa\s+)?(?:chiamata\s+|di\s+nome\s+|di\s+|per\s+)?[«"']?(?<list>(?!della\s+spesa\b)[\p{L}\p{N}][\p{L}\p{N}' -]{0,39}?)[»"']?\s*$/iu;

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

const cleanName = (s: string) =>
  s
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const withList = <T extends object>(plan: T, list: string | undefined): T & { list?: string } =>
  list ? { ...plan, list } : plan;

/** Riconosce le richieste sulle liste della spesa in italiano; null se non è una richiesta di questo tipo. */
export function parseShoppingCommand(input: string): ShoppingPlan | null {
  // Le tastiere mobili scrivono l'apostrofo tipografico (’): normalizzato prima di qualunque regola.
  const original = input
    .replace(/[‘’´`]/gu, "'")
    .trim()
    .replace(/[.!?]+$/gu, '')
    .trim();
  const lower0 = original.toLowerCase();
  if (!/lista|liste|spesa|comprare|prendere|preso|comprato/u.test(lower0)) return null;

  // --- operazioni sulle liste (prima delle voci: «cancella la lista X» ≠ «cancella il latte dalla lista») ---
  if (
    /^(?:quali|che|quante)\s+liste|^(?:mostra(?:mi)?|elenca(?:mi)?|fammi vedere|vedi|dimmi)\s+(?:tutte\s+)?(?:le\s+)?(?:mie\s+)?liste|^(?:le\s+)?mie\s+liste$|^liste(?:\s+della\s+spesa)?$/iu.test(
      lower0,
    )
  )
    return { op: 'lists' };
  let m =
    /^(?:crea(?:mi)?|fai|apri|nuova)\s+(?:una\s+)?(?:nuova\s+)?lista(?:\s+della\s+spesa)?(?:\s+(?:chiamata|di nome|per|di))?\s+(?<name>.+)$/iu.exec(
      original,
    );
  if (m?.groups?.name) return { op: 'create', name: cleanName(m.groups.name) };
  m = /^(?:rinomina|chiama)\s+(?:la\s+)?lista\s+(?<from>.+?)\s+(?:in|come)\s+(?<to>.+)$/iu.exec(
    original,
  );
  if (m?.groups?.from && m.groups.to)
    return { op: 'rename', from: cleanName(m.groups.from), to: cleanName(m.groups.to) };
  m =
    /^(?:archivia|chiudi|metti via)\s+(?:la\s+)?lista(?:\s+della\s+spesa)?(?:\s+(?<name>.+))?$/iu.exec(
      original,
    );
  if (m)
    return withList(
      { op: 'archive' as const },
      m.groups?.name ? cleanName(m.groups.name) : undefined,
    );
  m = /^(?:riprendi|ripristina|riapri|recupera|riattiva)\s+(?:la\s+)?lista\s+(?<name>.+)$/iu.exec(
    original,
  );
  if (m?.groups?.name) return { op: 'restore', list: cleanName(m.groups.name) };
  m =
    /^(?:elimina|cancella|butta(?: via)?)\s+(?:la\s+)?lista(?:\s+della\s+spesa)?\s+(?<name>.+)$/iu.exec(
      original,
    );
  if (m?.groups?.name) return { op: 'delete', list: cleanName(m.groups.name) };
  m = /^lista\s+(?<name>(?!della\s+spesa\b).+)$/iu.exec(original);
  if (m?.groups?.name) return { op: 'list', list: cleanName(m.groups.name) };

  // --- nome della lista in coda: lo stacco e normalizzo la frase su «… alla lista» ---
  let text = original;
  let list: string | undefined;
  const hint = LIST_HINT.exec(original);
  if (hint?.groups?.list) {
    list = cleanName(hint.groups.list);
    text = `${original.slice(0, hint.index).trim()} alla lista`;
  }
  const lower = text.toLowerCase();

  if (/^(ho fatto la spesa|spesa fatta|fatta la spesa)(?=\s|$)/u.test(lower))
    return withList({ op: 'clear' as const }, list);
  if (
    /^(svuota|azzera|pulisci)(?=\s|$)/u.test(lower) ||
    /(svuota|azzera)\s+(la\s+)?lista/u.test(lower)
  )
    return withList({ op: 'empty' as const }, list);

  const listPatterns = [
    /^(cosa|cos'|che|che cosa)\s*(c'è|c è|c'e|ce|è|ho|manca)(?=\s|$).*lista/u,
    /^(leggi|leggimi|mostra|mostrami|dimmi|fammi vedere|apri|vedi)(?=\s|$).*lista/u,
    /^lista(\s+della\s+spesa)?$/u,
    /^(lista|alla lista)$/u,
    /la lista (è|e')\s+aggiornata/u,
  ];
  if (listPatterns.some((re) => re.test(lower))) return withList({ op: 'list' as const }, list);

  const check = new RegExp(
    String.raw`^(?:ho (?:preso|comprato)|preso|comprato|spunta(?:mi)?|segna(?:mi)? (?:come )?(?:pres[oiae]|comprat[oiae]))\s+(?<items>.+?)(?:\s+(?:come )?(?:pres[oiae]|comprat[oiae]))?(?:\s+(?:${LIST}))?$`,
    'iu',
  );
  const ck = check.exec(text);
  if (ck?.groups?.items)
    return withList(
      { op: 'check' as const, names: splitItems(ck.groups.items), checked: true },
      list,
    );
  const uncheck = new RegExp(
    String.raw`^(?:non ho (?:preso|comprato)|rimetti(?:mi)?|togli la spunta a|ripristina)\s+(?<items>.+?)(?:\s+(?:${LIST}))?$`,
    'iu',
  );
  const uk = uncheck.exec(text);
  if (uk?.groups?.items)
    return withList(
      { op: 'check' as const, names: splitItems(uk.groups.items), checked: false },
      list,
    );

  const remove = new RegExp(
    String.raw`^(?:togli(?:mi)?|rimuovi|cancella|elimina|leva)\s+(?<items>.+?)\s+(?:${LIST})$`,
    'iu',
  );
  const rm = remove.exec(text);
  if (rm?.groups?.items)
    return withList({ op: 'remove' as const, names: splitItems(rm.groups.items) }, list);

  const add = new RegExp(
    String.raw`^(?:aggiungi(?:mi)?|metti(?:mi)?|inserisci|segna(?:mi)?)\s+(?<items>.+?)\s+(?:${LIST})$`,
    'iu',
  );
  const ad = add.exec(text);
  if (ad?.groups?.items)
    return withList(
      { op: 'add' as const, items: splitItems(ad.groups.items).map(parseItem) },
      list,
    );

  const need =
    /^(?:segna(?:mi)? che )?(?:devo|dobbiamo|mi serve|mi servono|ci serve|ci servono|ricordami di)\s+(?:(?:comprare|prendere)\s+)?(?<items>.+?)(?:\s+(?:per|alla|nella|in)\s+(?:la\s+)?(?:spesa|lista(?:\s+della\s+spesa)?))?$/iu;
  const nd = need.exec(text);
  if (nd?.groups?.items && !/\b(cose|roba|ingredienti)\s+per\b/iu.test(nd.groups.items)) {
    return withList(
      { op: 'add' as const, items: splitItems(nd.groups.items).map(parseItem) },
      list,
    );
  }

  return null;
}

function joinIt(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

const wordsFor = (items: ReadonlyArray<{ name: string; quantity: string | null }>) =>
  items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));

export function createShoppingListSkill(repo: ShoppingListRepository): DeterministicSkill {
  const card = async (userId: string, list: ShoppingList) =>
    toShoppingBlock(
      (await repo.getList(userId, list.id)) ?? list,
      await repo.items(userId, list.id),
    );

  /** Lista intesa, oppure la risposta con la scelta (l'app rimanda la frase con il nome scelto). */
  const choose = async (
    userId: string,
    hint: string | undefined,
    original: string,
    createDefault: boolean,
  ): Promise<{ list: ShoppingList } | { reply: SkillReply }> => {
    const r = await repo.resolve(userId, hint, { createDefault });
    if (r.kind === 'list') return { list: r.list };
    if (r.kind === 'choose')
      return {
        reply: {
          text: hint ? `Più liste somigliano a «${hint}»: quale?` : 'Quale lista? Tocca una lista.',
          actions: ['choose'],
          blocks: [toChooserBlock(r.lists, 'Quale lista?', original)],
        },
      };
    return {
      reply: {
        text: hint
          ? `Non ho una lista chiamata «${hint}». Vuoi crearla? Dimmi «crea una lista ${hint}».`
          : 'Non hai ancora liste: dimmi «crea una lista» con il nome che vuoi.',
        actions: ['none'],
      },
    };
  };

  return {
    id: 'shopping_list',
    kind: 'deterministic',
    category: 'shopping_list',
    description:
      'Gestisce le liste della spesa a parole: aggiunge, toglie e spunta le voci, legge una lista, crea, archivia, rinomina ed elimina le liste.',
    examples: [
      'aggiungi il latte alla lista',
      'togli il pane dalla lista Esselunga',
      "cosa c'è nella lista della spesa?",
      'ho preso il latte',
      'crea una lista Natale',
      'quali liste ho?',
      'archivia la lista Esselunga',
    ],
    match: (text) => parseShoppingCommand(text),
    run: async (plan, ctx): Promise<SkillReply> => {
      const p = plan as ShoppingPlan;
      const u = ctx.userId;
      // La frase originale non è nel piano: per la scelta si usa una forma rigenerata dal piano.
      const pending = describe(p);
      switch (p.op) {
        case 'lists': {
          const lists = await repo.lists(u, { includeArchived: true });
          if (!lists.length)
            return {
              text: 'Non hai ancora liste. Dimmi «crea una lista» con il nome che vuoi.',
              actions: ['lists'],
            };
          const active = lists.filter((l) => l.status === 'active');
          return {
            text: `Hai ${lists.length} ${lists.length === 1 ? 'lista' : 'liste'}${active.length !== lists.length ? ` (${active.length} attive)` : ''}: ${joinIt(lists.map((l) => `${l.name} (${l.open} da prendere)`))}.`,
            actions: ['lists'],
            blocks: [toChooserBlock(lists, 'Le tue liste')],
          };
        }
        case 'create': {
          const l = await repo.createList(u, p.name);
          return {
            text: `Lista «${l.name}» pronta.`,
            actions: [`create:${l.name}`],
            blocks: [await card(u, l)],
          };
        }
        case 'rename': {
          const c = await choose(u, p.from, pending, false);
          if ('reply' in c) return c.reply;
          const l = await repo.renameList(u, c.list.id, p.to);
          return l
            ? {
                text: `Lista rinominata in «${l.name}».`,
                actions: [`rename:${l.name}`],
                blocks: [await card(u, l)],
              }
            : { text: 'Lista non trovata.', actions: [] };
        }
        case 'archive': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          const l = await repo.setListStatus(u, c.list.id, 'archived');
          return {
            text: `Lista «${c.list.name}» archiviata: la ritrovi quando vuoi con «riprendi la lista ${c.list.name}».`,
            actions: [`archive:${c.list.name}`],
            ...(l ? { blocks: [await card(u, l)] } : {}),
          };
        }
        case 'restore': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          const l = await repo.setListStatus(u, c.list.id, 'active');
          return {
            text: `Lista «${c.list.name}» ripristinata.`,
            actions: [`restore:${c.list.name}`],
            ...(l ? { blocks: [await card(u, l)] } : {}),
          };
        }
        case 'delete': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          await repo.deleteList(u, c.list.id);
          return { text: `Lista «${c.list.name}» eliminata.`, actions: [`delete:${c.list.name}`] };
        }
        case 'add': {
          const c = await choose(u, p.list, pending, true);
          if ('reply' in c) return c.reply;
          const r = await repo.add(u, c.list.id, p.items, 'skill');
          const added = wordsFor(r.added);
          const parts: string[] = [];
          if (added.length) parts.push(`Aggiunto ${joinIt(added)} alla lista «${c.list.name}».`);
          if (r.alreadyPresent.length)
            parts.push(
              `${joinIt(r.alreadyPresent)} ${r.alreadyPresent.length > 1 ? 'erano' : 'era'} già in lista.`,
            );
          return {
            text: parts.join(' ') || 'Non ho capito cosa aggiungere.',
            actions: added.map((a) => `add:${a}`),
            blocks: [await card(u, c.list)],
          };
        }
        case 'remove': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          const r = await repo.remove(u, c.list.id, p.names);
          const parts: string[] = [];
          if (r.removed.length)
            parts.push(`Tolto ${joinIt(r.removed)} dalla lista «${c.list.name}».`);
          if (r.notFound.length)
            parts.push(
              `${joinIt(r.notFound)} non ${r.notFound.length > 1 ? 'erano' : 'era'} in lista.`,
            );
          return {
            text: parts.join(' '),
            actions: r.removed.map((n) => `remove:${n}`),
            blocks: [await card(u, c.list)],
          };
        }
        case 'check': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          const r = await repo.setChecked(u, c.list.id, p.names, p.checked);
          const parts: string[] = [];
          if (r.changed.length)
            parts.push(
              p.checked
                ? `Segnato come preso: ${joinIt(r.changed)}.`
                : `Rimesso da prendere: ${joinIt(r.changed)}.`,
            );
          if (r.notFound.length)
            parts.push(
              `${joinIt(r.notFound)} non ${r.notFound.length > 1 ? 'erano' : 'era'} in lista.`,
            );
          return {
            text: parts.join(' '),
            actions: r.changed.map((n) => `${p.checked ? 'check' : 'uncheck'}:${n}`),
            blocks: [await card(u, c.list)],
          };
        }
        case 'list': {
          const c = await choose(u, p.list, pending, true);
          if ('reply' in c) return c.reply;
          await repo.touch(u, c.list.id);
          const items = await repo.items(u, c.list.id);
          const open = items.filter((i) => i.status === 'active');
          const block = toShoppingBlock(c.list, items);
          if (items.length === 0)
            return {
              text: `La lista «${c.list.name}» è vuota.`,
              actions: ['list'],
              blocks: [block],
            };
          const names = wordsFor(open);
          const bought = items.length - open.length;
          const tail = bought ? ` (${bought} già ${bought === 1 ? 'presa' : 'prese'})` : '';
          if (open.length === 0)
            return {
              text: `🛒 «${c.list.name}»: tutto preso${tail}.`,
              actions: ['list'],
              blocks: [block],
            };
          // Fino a quattro voci una frase; oltre, un elenco puntato (leggibile nell'app, letto riga per riga dal TTS).
          if (open.length <= 4)
            return {
              text: `🛒 «${c.list.name}»: da prendere ${joinIt(names)}${tail}.`,
              actions: ['list'],
              blocks: [block],
            };
          return {
            text: `🛒 «${c.list.name}»: ${open.length} voci da prendere${tail}:\n${names.map((n) => `- ${n}`).join('\n')}`,
            actions: ['list'],
            blocks: [block],
          };
        }
        case 'clear': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          const n = await repo.markAllBought(u, c.list.id);
          return {
            text:
              n > 0
                ? `Segnate come prese ${n} ${n === 1 ? 'voce' : 'voci'} di «${c.list.name}». Spesa fatta!`
                : `In «${c.list.name}» non c'era nulla da prendere.`,
            actions: [`clear:${n}`],
            blocks: [await card(u, c.list)],
          };
        }
        case 'empty': {
          const c = await choose(u, p.list, pending, false);
          if ('reply' in c) return c.reply;
          const n = await repo.empty(u, c.list.id);
          return {
            text:
              n > 0
                ? `Lista «${c.list.name}» svuotata (${n} ${n === 1 ? 'voce' : 'voci'}).`
                : `La lista «${c.list.name}» era già vuota.`,
            actions: [`empty:${n}`],
            blocks: [await card(u, c.list)],
          };
        }
        default:
          return { text: 'Richiesta non riconosciuta.', actions: [] };
      }
    },
  };
}

/** Frase rigenerata dal piano con il segnaposto `{lista}`: l'app lo sostituisce con il nome scelto e la rimanda. */
export function describe(p: ShoppingPlan): string {
  const items = (xs: readonly string[]) => joinIt(xs);
  switch (p.op) {
    case 'add':
      return `aggiungi ${items(p.items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name)))} nella lista {lista}`;
    case 'remove':
      return `togli ${items(p.names)} dalla lista {lista}`;
    case 'check':
      return `${p.checked ? 'ho preso' : 'non ho preso'} ${items(p.names)} nella lista {lista}`;
    case 'clear':
      return 'ho fatto la spesa nella lista {lista}';
    case 'empty':
      return 'svuota la lista {lista}';
    case 'archive':
      return 'archivia la lista {lista}';
    case 'rename':
      return `rinomina la lista {lista} in ${p.to}`;
    default:
      return 'mostrami la lista {lista}';
  }
}
