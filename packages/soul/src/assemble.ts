import { CORE_SOUL_TOKEN_BUDGET, estimateTokens } from './tokens.js';

export type SoulKind = 'core' | 'context' | 'policy';

export interface Soul {
  readonly id: string;
  readonly key: string;
  readonly kind: SoulKind;
  readonly userId: string | null;
  readonly tags: readonly string[];
  readonly version: number;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly enabled: boolean;
  readonly locked: boolean;
}

export interface AssembleInput {
  readonly souls: readonly Soul[];
  /** Tag di contesto della sessione (es. ['cucina']): scelti a livello di sessione, mai per turno. */
  readonly contextTags: readonly string[];
  readonly companionName: string;
}

export interface AssembledSoul {
  readonly instructions: string;
  readonly tokenEstimate: number;
  readonly used: readonly string[];
  /** Hash stabile del contenuto: cambia solo se cambiano i Soul usati. */
  readonly fingerprint: string;
}

export class SoulBudgetError extends Error {
  override readonly name = 'SoulBudgetError';
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Precedenza: il Soul dell'utente sostituisce il globale con la stessa chiave.
 * Le policy si sommano (globali + utente); i context entrano solo se un loro tag è attivo in sessione.
 * Output deterministico: stesso input → stessa stringa (prefisso di cache stabile).
 */
export function assembleSoul(input: AssembleInput): AssembledSoul {
  const byKey = new Map<string, Soul>();
  for (const s of input.souls) {
    if (!s.enabled) continue;
    const existing = byKey.get(s.key);
    if (!existing || (existing.userId === null && s.userId !== null)) byKey.set(s.key, s);
  }
  const chosen = [...byKey.values()];

  const core = chosen.find((s) => s.kind === 'core');
  if (!core) throw new SoulBudgetError('nessun Core Soul disponibile');
  if (
    core.tokenEstimate > CORE_SOUL_TOKEN_BUDGET ||
    estimateTokens(core.content) > CORE_SOUL_TOKEN_BUDGET
  ) {
    throw new SoulBudgetError(`Core Soul oltre il budget di ${CORE_SOUL_TOKEN_BUDGET} token`);
  }

  const tagSet = new Set(input.contextTags);
  const contexts = chosen
    .filter((s) => s.kind === 'context' && s.tags.some((t) => tagSet.has(t)))
    .sort((a, b) => a.key.localeCompare(b.key));
  const policies = chosen
    .filter((s) => s.kind === 'policy')
    .sort((a, b) => a.key.localeCompare(b.key));

  const parts = [
    core.content.replaceAll('Ernie', input.companionName),
    ...contexts.map((c) => c.content),
    ...policies.map((p) => p.content),
  ];
  const instructions = parts.join('\n\n');
  const used = [core, ...contexts, ...policies].map((s) => `${s.key}@${s.version}`);
  return {
    instructions,
    tokenEstimate: estimateTokens(instructions),
    used,
    fingerprint: fnv1a(instructions),
  };
}
