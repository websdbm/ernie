import type { DeterministicSkill, SkillReply } from './types.js';
import { localParts } from './zoned.js';

/**
 * Skill «Ricordi» (M9 A4, idea presa da Muffin: «perché lo sai?»). Trasparenza e controllo sulla memoria,
 * senza modello: «cosa sai di me?» elenca i ricordi con data e provenienza, «perché sai che …?» mostra da
 * dove viene un ricordo, «dimentica che …» lo cancella (stato `deleted`, recuperabile dal database fino alla
 * retention). Non sta nel catalogo: la trasparenza non si spegne.
 */
export interface MemoryFact {
  readonly id: string;
  readonly content: string;
  readonly category: string | null;
  readonly confidence: number;
  readonly createdAt: Date;
  readonly seenCount: number;
  readonly provenance: { readonly source: string; readonly trust: number; readonly note?: string };
  /** «disputed» = in dubbio: due ricordi in conflitto finché la persona non chiarisce (ricerca 11, M1). */
  readonly status?: string;
}

export interface MemoryLookup {
  search(userId: string, query: string, limit: number): Promise<MemoryFact[]>;
  listActiveSemantic(userId: string, limit: number): Promise<MemoryFact[]>;
  forget(userId: string, id: string): Promise<boolean>;
  /** Righe della scheda anagrafica (nome, età, famiglia…), mostrate per prime: hanno la precedenza sui ricordi. */
  profileLines?(userId: string): Promise<string[]>;
}

export type MemoryPlan =
  | { op: 'list' }
  | { op: 'why'; what: string }
  | { op: 'forget'; what: string };

const LIST_RE =
  /^(?:ernie[,\s]+)?(?:cosa|che cosa|cos['’])\s*(?:sai|ricordi|hai\s+imparato)\s+(?:di|su(?:\s+di)?)\s+me\s*\??$/iu;
const WHY_RE =
  /^(?:ernie[,\s]+)?(?:perch[eé]\s+(?:lo\s+)?(?:sai|ricordi)|come\s+fai\s+a\s+sapere|da\s+dove\s+sai|chi\s+ti\s+ha\s+detto)\s+(?:che\s+)?(?<what>.{3,200}?)\s*\??$/iu;
const FORGET_RE =
  /^(?:ernie[,\s]+)?(?:dimentica(?:ti)?|scordati|cancella\s+dalla\s+memoria)\s+(?:che\s+|di\s+|il\s+fatto\s+che\s+)?(?<what>.{3,200}?)\s*[.!]?$/iu;

export function parseMemoryRequest(text: string): MemoryPlan | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (LIST_RE.test(t)) return { op: 'list' };
  const why = WHY_RE.exec(t);
  // «perché lo sai?» senza oggetto va al modello (serve il contesto della conversazione).
  if (why?.groups?.what && !/^(?:lo|questo|ciò|cio)\s*(?:sai)?$/i.test(why.groups.what))
    return { op: 'why', what: why.groups.what };
  const forget = FORGET_RE.exec(t);
  if (forget?.groups?.what && !/^(?:tutto|ogni cosa)$/i.test(forget.groups.what))
    return { op: 'forget', what: forget.groups.what };
  return null;
}

const CATEGORY: Record<string, string> = {
  preference: 'Preferenze',
  habit: 'Abitudini',
  relationship: 'Persone',
  project: 'Progetti',
  fact: 'Fatti',
  outcome: 'Esiti',
  error: 'Errori',
  other: 'Altro',
};

/** Provenienza in parole: da dove viene il ricordo e quanto è sicuro. */
export function provenanceLabel(f: MemoryFact, tz: string): string {
  const p = localParts(f.createdAt, tz);
  const months = [
    'gennaio',
    'febbraio',
    'marzo',
    'aprile',
    'maggio',
    'giugno',
    'luglio',
    'agosto',
    'settembre',
    'ottobre',
    'novembre',
    'dicembre',
  ];
  const day = `${p.day} ${months[p.month - 1]}`;
  const how = f.confidence >= 0.85 ? 'me l’avevi detto tu' : 'l’ho dedotto da quello che dicevi';
  const where =
    f.provenance.source === 'assistant' || f.provenance.source === 'user'
      ? `da una nostra conversazione del ${day}: ${how}`
      : f.provenance.source === 'system'
        ? `dal registro di ciò che abbiamo fatto il ${day}`
        : `da una fonte esterna (${f.provenance.source}) il ${day}, quindi da prendere con cautela`;
  const seen = f.seenCount > 1 ? `; è tornato fuori ${f.seenCount} volte` : '';
  return `${where}${seen}`;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );

/** Sovrapposizione lessicale minima tra richiesta e ricordo: evita di cancellare un ricordo a caso. */
export function plausible(query: string, content: string): boolean {
  const q = words(query);
  if (q.size === 0) return false;
  const c = words(content);
  let hit = 0;
  for (const w of q)
    if ([...c].some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))) hit++;
  return hit >= Math.min(2, q.size) || hit / q.size >= 0.5;
}

export function createMemorySkill(
  store: MemoryLookup | null,
  timezone = 'Europe/Rome',
): DeterministicSkill {
  return {
    id: 'ricordi',
    kind: 'deterministic',
    category: 'memory',
    description:
      'Trasparenza sulla memoria: «cosa sai di me?», «perché sai che …?», «dimentica che …». Senza modello.',
    examples: ['cosa sai di me?', 'perché sai che mi piace il tè?', 'dimentica che ho un cane'],
    match: (text) => parseMemoryRequest(text),
    async run(plan, ctx): Promise<SkillReply> {
      const p = plan as MemoryPlan;
      if (!store) return { text: 'La memoria non è disponibile su questo server.', actions: [] };
      if (p.op === 'list') {
        const facts = await store.listActiveSemantic(ctx.userId, 40);
        const profile = (await store.profileLines?.(ctx.userId).catch(() => [])) ?? [];
        const card = profile.length
          ? `**La tua scheda** (puoi correggerla in Impostazioni › La tua scheda)\n${profile.join('\n')}\n\n`
          : '';
        if (facts.length === 0 && card)
          return {
            text: `${card}Altri ricordi su di te non ne ho ancora: li annoto quando mi racconti preferenze, abitudini, persone e progetti.`,
            actions: ['ricordi:list'],
          };
        if (facts.length === 0)
          return {
            text: 'Non ho ancora ricordi su di te: li annoto quando mi racconti preferenze, abitudini, persone e progetti.',
            actions: ['ricordi:list'],
          };
        const groups = new Map<string, MemoryFact[]>();
        for (const f of facts) {
          const k = CATEGORY[f.category ?? 'other'] ?? 'Altro';
          groups.set(k, [...(groups.get(k) ?? []), f]);
        }
        const body = [...groups.entries()]
          .map(
            ([k, fs]) =>
              `**${k}**\n${fs.map((f) => `- ${f.content}${f.status === 'disputed' ? ' (in dubbio)' : ''}`).join('\n')}`,
          )
          .join('\n\n');
        return {
          text: `${card}Ecco cosa ricordo di te (${facts.length}):\n\n${body}\n\nChiedimi «perché sai che …?» per la provenienza, o «dimentica che …» per cancellare un ricordo.`,
          actions: ['ricordi:list'],
        };
      }
      const hits = (await store.search(ctx.userId, p.what, 3)).filter((h) =>
        plausible(p.what, h.content),
      );
      if (p.op === 'why') {
        const top = hits[0];
        if (!top)
          return {
            text: `Non ho un ricordo salvato su «${p.what}». Se l'ho detto, viene dalla conversazione in corso, da un documento o da una pagina letta adesso, non dalla mia memoria.`,
            actions: ['ricordi:why:none'],
          };
        const others = hits.slice(1).map((h) => `- ${h.content}`);
        const doubt =
          top.status === 'disputed'
            ? ' È in dubbio: ho anche un ricordo che lo contraddice, dimmi tu quale vale.'
            : '';
        return {
          text: `Ricordo che: «${top.content}». L'ho annotato ${provenanceLabel(top, timezone)}.${doubt}${others.length ? `\n\nRicordi vicini:\n${others.join('\n')}` : ''}\n\nSe non è più vero, dimmi «dimentica che ${p.what}».`,
          actions: ['ricordi:why'],
        };
      }
      const top = hits[0];
      if (!top)
        return {
          text: `Non trovo un ricordo su «${p.what}»: non ho cancellato nulla. Prova con altre parole, o chiedimi «cosa sai di me?».`,
          actions: ['ricordi:forget:none'],
        };
      const ok = await store.forget(ctx.userId, top.id);
      return ok
        ? {
            text: `Fatto, ho dimenticato: «${top.content}». Se intendevi un altro ricordo, dimmelo con altre parole.`,
            actions: [`ricordi:forget:${top.id}`],
          }
        : { text: 'Non sono riuscito a cancellare il ricordo: riprova tra poco.', actions: [] };
    },
  };
}
