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
  /** I parametri lasciano il dispositivo verso un servizio esterno (ricerca, fetch): canale di fuga per dati privati. */
  readonly egress?: boolean;
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
  /** Nella run un tool ha letto dati privati (liste, documenti, memoria). */
  readonly privateRead?: boolean;
  readonly riskSignal: number;
  readonly policyVersion?: string;
}

export type PolicyVerdict =
  | { readonly kind: 'allow' }
  /** `exfiltration`: possibile fuga di dati; «Consenti sempre» non vale, si chiede ogni volta. */
  | { readonly kind: 'ask'; readonly reason: string; readonly exfiltration?: true }
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
  // Terza gamba della Rule of Two: contenuto non fidato + dati privati + canale verso l'esterno = possibile esfiltrazione.
  if (tool.risk.egress && ctx.tainted && ctx.privateRead) {
    return {
      kind: 'ask',
      reason:
        "possibile fuga di dati: nella run ci sono contenuti non fidati e dati privati, e questo tool invia i parametri all'esterno (Rule of Two)",
      exfiltration: true,
    };
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
  private _privateRead = false;
  private readonly privateSources_: string[] = [];

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

  get privateRead(): boolean {
    return this._privateRead;
  }

  get privateSources(): readonly string[] {
    return this.privateSources_;
  }

  /** Un tool ha letto dati privati: da qui, con contenuto non fidato nella run, i tool `egress` chiedono conferma. */
  markPrivateRead(source: string): void {
    this._privateRead = true;
    this.privateSources_.push(source);
  }

  toPolicyContext(): PolicyContext {
    return {
      userId: this.userId,
      scopes: this.scopes,
      tainted: this._tainted,
      privateRead: this._privateRead,
      riskSignal: this.riskSignal,
    };
  }
}
