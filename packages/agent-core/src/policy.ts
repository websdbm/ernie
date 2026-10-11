/**
 * Policy Engine deterministico (ARCHITECTURE.md §15; 03-revisione A.1–A.2).
 * deny → ask → allow, fuori dall'LLM, fail-closed per tool sconosciuti.
 * Rule of Two come taint di run: dopo contenuto non fidato ogni tool con effetto esterno o scrittura passa in `ask`.
 */

export interface ToolRisk {
  readonly readsPrivate: boolean;
  readonly ingestsUntrusted: boolean;
  readonly externalEffect: boolean;
  readonly write: boolean;
}

export interface ToolPolicyDescriptor {
  readonly id: string;
  readonly risk: ToolRisk;
  readonly requiredScopes?: readonly string[];
}

export interface PolicyRules {
  readonly denyTools?: readonly string[];
  readonly alwaysAsk?: readonly string[];
  /** Con riskSignal del router ≥ soglia, i tool con effetto esterno richiedono conferma. */
  readonly riskAskThreshold?: number;
}

export interface PolicyContext {
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly tainted: boolean;
  readonly riskSignal: number;
  readonly policyVersion?: string;
}

export type PolicyVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string };

export const DEFAULT_POLICY_RULES: PolicyRules = {
  denyTools: [],
  alwaysAsk: [],
  riskAskThreshold: 0.75,
};

export function evaluateToolPolicy(
  tool: ToolPolicyDescriptor | undefined,
  ctx: PolicyContext,
  rules: PolicyRules = DEFAULT_POLICY_RULES,
): PolicyVerdict {
  if (!tool) return { kind: 'deny', reason: 'tool sconosciuto' };
  if (rules.denyTools?.includes(tool.id))
    return { kind: 'deny', reason: 'tool vietato dalla policy' };
  for (const scope of tool.requiredScopes ?? []) {
    if (!ctx.scopes.includes(scope)) return { kind: 'deny', reason: `scope mancante: ${scope}` };
  }
  if (rules.alwaysAsk?.includes(tool.id))
    return { kind: 'ask', reason: 'conferma sempre richiesta per questo tool' };
  if (ctx.tainted && (tool.risk.externalEffect || tool.risk.write)) {
    return { kind: 'ask', reason: 'run contaminata da contenuto non fidato (Rule of Two)' };
  }
  const threshold = rules.riskAskThreshold ?? 0.75;
  if (tool.risk.externalEffect && ctx.riskSignal >= threshold) {
    return {
      kind: 'ask',
      reason: `azione con effetto esterno con rischio ${ctx.riskSignal.toFixed(2)}`,
    };
  }
  return { kind: 'allow' };
}

/** Stato di contaminazione di una run: diventa `tainted` quando entra contenuto non fidato. */
export class RunContext {
  private _tainted = false;
  private readonly sources: string[] = [];

  constructor(
    readonly userId: string,
    readonly scopes: readonly string[],
    readonly riskSignal: number,
  ) {}

  get tainted(): boolean {
    return this._tainted;
  }

  get taintSources(): readonly string[] {
    return this.sources;
  }

  markUntrusted(source: string): void {
    this._tainted = true;
    this.sources.push(source);
  }

  toPolicyContext(): PolicyContext {
    return {
      userId: this.userId,
      scopes: this.scopes,
      tainted: this._tainted,
      riskSignal: this.riskSignal,
    };
  }
}
