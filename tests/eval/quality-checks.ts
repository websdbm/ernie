import type { Check, QualityState, TurnEvidence } from './quality-types.js';

export const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const contains = (text: string, part: string) => normalize(text).includes(normalize(part));
const sameTime = (a: string | null, b: string) =>
  a !== null && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return JSON.stringify(value);
}
export function unchanged(
  before: QualityState,
  after: QualityState,
  domain: keyof QualityState,
): boolean {
  return canonical(before[domain]) === canonical(after[domain]);
}

/** No prose judge. Only protocol evidence and authoritative persisted state. */
export function checkInvariant(
  check: Check,
  before: QualityState,
  after: QualityState,
  evidence: TurnEvidence,
): boolean {
  switch (check.kind) {
    case 'unchanged':
      return check.domains.every((d) => unchanged(before, after, d));
    case 'count':
      return after[check.domain].length === check.value;
    case 'reminder':
      return (
        after.reminders.filter(
          (r) =>
            check.words.every((w) => contains(r.text, w)) &&
            sameTime(r.at, check.at) &&
            (check.eventAt === undefined || sameTime(r.eventAt, check.eventAt)),
        ).length === 1
      );
    case 'shopping': {
      const list = after.shopping.filter((l) => normalize(l.name) === normalize(check.list));
      return (
        list.length === 1 &&
        list[0]?.items.length === check.exactCount &&
        check.items.every(
          (expected) =>
            list[0]?.items.filter(
              (i) =>
                normalize(i.name) === normalize(expected.name) &&
                !i.checked &&
                (expected.quantity === undefined ||
                  normalize(i.quantity ?? '') === normalize(expected.quantity)),
            ).length === 1,
        )
      );
    }
    case 'shoppingChoice':
      return evidence.blocks.some(
        (block) =>
          block.kind === 'shopping_lists' &&
          Array.isArray(block.lists) &&
          canonical(block.lists.map((l: { name?: string }) => normalize(l.name ?? ''))) ===
            canonical(check.names.map(normalize)) &&
          typeof block.pendingText === 'string',
      );
    case 'todo': {
      const list = after.todos.filter((l) => normalize(l.name) === normalize(check.name));
      if (list.length !== 1 || list[0]?.items.length !== check.items.length) return false;
      if (
        !check.items.every(
          (x) =>
            list[0]?.items.filter(
              (i) => normalize(i.title) === normalize(x.title) && i.status === x.status,
            ).length === 1,
        )
      )
        return false;
      if (list[0]?.mode !== 'simple' || list[0]?.items.some((i) => i.slots.length !== 0))
        return false;
      const old = before.todos.find((l) => normalize(l.name) === normalize(check.name));
      return (
        !check.preserveIds ||
        (old?.id === list[0]?.id &&
          Boolean(old) &&
          old?.items.every((item) =>
            list[0]?.items.some(
              (next) => next.id === item.id && normalize(next.title) === normalize(item.title),
            ),
          ) === true)
      );
    }
    case 'brain':
      return (
        after.brain.filter(
          (n) =>
            normalize(n.title) === normalize(check.title) &&
            check.contains.every((part) => contains(n.body, part)),
        ).length === 1
      );
    case 'recipe':
      return (
        after.recipes.filter(
          (r) =>
            normalize(r.title) === normalize(check.title) &&
            r.ingredients.length === check.ingredientCount &&
            check.ingredients.every((part) => contains(r.ingredients.join(' '), part)) &&
            check.steps.every((part) => contains(r.steps.join(' '), part)),
        ).length === 1
      );
    case 'outputContains':
      return contains(`${evidence.text} ${JSON.stringify(evidence.blocks)}`, check.value);
    case 'block':
      return evidence.blocks.some(
        (b) =>
          b.kind === check.block &&
          (check.title === undefined || contains(JSON.stringify(b), check.title)),
      );
    case 'toolAny':
      return evidence.tools.some((tool) => tool.ok === true && check.tools.includes(tool.id));
  }
}

export function evaluateTurn(
  checks: Check[],
  before: QualityState,
  after: QualityState,
  evidence: TurnEvidence,
) {
  return [
    { id: 'protocol-completed', passed: evidence.terminal === 'completed' },
    {
      id: 'visible-response',
      passed:
        evidence.firstResponseMs !== null &&
        (Boolean(evidence.text.trim()) || evidence.blocks.length > 0),
    },
    {
      id: 'cards-unique',
      passed: new Set(evidence.blocks.map(canonical)).size === evidence.blocks.length,
    },
    { id: 'tool-calls-completed', passed: evidence.tools.every((tool) => tool.ok !== null) },
    ...checks.map((check, index) => ({
      id: `${check.kind}:${index}`,
      passed: checkInvariant(check, before, after, evidence),
    })),
  ];
}
