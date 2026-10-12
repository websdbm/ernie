/**
 * Compattazione dei risultati dei tool nel contesto del modello (M9 A1; idea presa da Muffin,
 * `docs/research/10-muffin-agent.md`). Agisce sul prompt inviato al provider (hook `processLLMRequest`
 * di Mastra), mai sui messaggi salvati: la cronologia resta integra e il modello vede i risultati
 * vecchi e voluminosi sostituiti da un segnaposto con nome del tool e dimensione. Restano interi:
 * le chiamate (nome e argomenti), i risultati del turno corrente, gli ultimi `keepRecent` della
 * cronologia, gli errori e i risultati dei tool protetti (memoria), che non vanno mai cancellati.
 *
 * La compattazione scatta a lotti: solo quando i risultati storici compattabili superano
 * `historyBudgetChars` si compattano tutti insieme. Ogni cambiamento del prompt invalida la cache del
 * prefisso da quel punto in avanti (misurato il 12 ott 2026: a cache calda un turno è costato di più),
 * quindi conviene cambiare il prefisso di rado e in blocco, non a ogni turno.
 */
import type { Processor } from '@mastra/core/processors';

export interface CompactionOptions {
  /** Sotto questa dimensione (caratteri del risultato serializzato) non si compatta. */
  readonly minChars?: number;
  /** Quanti risultati recenti della cronologia restano interi, oltre a quelli del turno corrente. */
  readonly keepRecent?: number;
  /**
   * Totale (caratteri) dei risultati storici compattabili oltre il quale scatta la compattazione di
   * tutti insieme; sotto, il prompt resta com'è e la cache del prefisso vale. 0 = compatta sempre.
   */
  readonly historyBudgetChars?: number;
  /** Tool i cui risultati non si compattano mai (memoria: toglierli cambia ciò che l'agente «sa»). */
  readonly protectedTools?: readonly string[];
  /** Chiamata a ogni step in cui qualcosa è stato compattato (per log e misure). */
  readonly onCompacted?: (stats: CompactionStats) => void;
}

export interface CompactionStats {
  readonly stepNumber: number;
  /** Risultati sostituiti dal segnaposto in questo step. */
  readonly compacted: number;
  /** Caratteri tolti dal prompt (serializzazione dei risultati). */
  readonly removedChars: number;
  /** Risultati di tool presenti nel prompt, compattati o no. */
  readonly toolResults: number;
}

/** Forma minima del prompt del provider (AI SDK): bastano ruolo e parti, il resto passa intatto. */
export interface PromptToolResultPart {
  readonly type: 'tool-result';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: { readonly type: string; readonly value: unknown };
  readonly [k: string]: unknown;
}

export interface PromptMessage {
  readonly role: string;
  readonly content: unknown;
  readonly [k: string]: unknown;
}

export type ModelPrompt = readonly PromptMessage[];

export const DEFAULT_COMPACTION = {
  minChars: 400,
  keepRecent: 2,
  historyBudgetChars: 24_000,
  protectedTools: ['memory_search'] as readonly string[],
} as const;

const isToolResult = (p: unknown): p is PromptToolResultPart =>
  !!p &&
  typeof p === 'object' &&
  (p as { type?: unknown }).type === 'tool-result' &&
  typeof (p as { toolCallId?: unknown }).toolCallId === 'string' &&
  typeof (p as { toolName?: unknown }).toolName === 'string' &&
  !!(p as { output?: unknown }).output;

/** Dimensione del risultato come arriva al modello (stringa o JSON serializzato). */
export function resultSize(output: PromptToolResultPart['output']): number {
  const v = output.value;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v ?? null).length;
  } catch {
    return 0;
  }
}

/** Gli errori restano: il modello deve ricordare che cosa non ha funzionato per non ripeterlo. */
export function isErrorOutput(output: PromptToolResultPart['output']): boolean {
  if (output.type.startsWith('error')) return true;
  const v = output.value;
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'error' in (v as object);
}

export function placeholder(toolName: string, chars: number): string {
  return `[risultato di ${toolName} rimosso dal contesto (${chars} caratteri): se ti serve ancora, richiama il tool]`;
}

/**
 * Sostituisce i risultati vecchi e grandi con il segnaposto, tutti insieme e solo quando il loro totale
 * supera `historyBudgetChars`. `keepIds` sono le chiamate del turno corrente.
 * Non muta il prompt ricevuto: restituisce lo stesso array se non c'è nulla da compattare.
 */
export function compactPrompt(
  prompt: ModelPrompt,
  keepIds: ReadonlySet<string>,
  opts: CompactionOptions = {},
): { prompt: ModelPrompt; stats: Omit<CompactionStats, 'stepNumber'> } {
  const minChars = opts.minChars ?? DEFAULT_COMPACTION.minChars;
  const keepRecent = Math.max(0, opts.keepRecent ?? DEFAULT_COMPACTION.keepRecent);
  const budget = opts.historyBudgetChars ?? DEFAULT_COMPACTION.historyBudgetChars;
  const protectedTools = new Set(opts.protectedTools ?? DEFAULT_COMPACTION.protectedTools);

  const all: PromptToolResultPart[] = [];
  for (const m of prompt)
    if (Array.isArray(m.content)) for (const p of m.content) if (isToolResult(p)) all.push(p);
  const historical = all.filter((p) => !keepIds.has(p.toolCallId));
  const recent = new Set(
    (keepRecent ? historical.slice(-keepRecent) : []).map((p) => p.toolCallId),
  );
  // Candidati: storici, non recenti, non protetti, non errori, abbastanza grandi.
  const sizes = new Map<string, number>();
  for (const p of historical) {
    if (recent.has(p.toolCallId) || protectedTools.has(p.toolName) || isErrorOutput(p.output))
      continue;
    const size = resultSize(p.output);
    if (size >= minChars) sizes.set(p.toolCallId, size);
  }
  let total = 0;
  for (const s of sizes.values()) total += s;
  if (sizes.size === 0 || total < budget)
    return { prompt, stats: { compacted: 0, removedChars: 0, toolResults: all.length } };

  let compacted = 0;
  let removedChars = 0;
  const out = prompt.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = (m.content as unknown[]).map((p) => {
      if (!isToolResult(p)) return p;
      const size = sizes.get(p.toolCallId);
      if (size === undefined) return p;
      changed = true;
      compacted++;
      removedChars += size;
      return { ...p, output: { type: 'text', value: placeholder(p.toolName, size) } };
    });
    return changed ? { ...m, content } : m;
  });
  return { prompt: out, stats: { compacted, removedChars, toolResults: all.length } };
}

/** Id delle chiamate tool del turno corrente, dagli step già eseguiti (`StepResult` dell'AI SDK). */
export function currentTurnToolCallIds(steps: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  const visit = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      const id = (x as { toolCallId?: unknown } | null)?.toolCallId;
      if (typeof id === 'string') ids.add(id);
    }
  };
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const st = s as Record<string, unknown>;
    visit(st.toolCalls);
    visit(st.toolResults);
    visit(st.content);
  }
  return ids;
}

export const TOOL_RESULT_COMPACTOR_ID = 'ernie-tool-result-compactor';

/** Processore con il solo hook sulla richiesta al provider (Mastra vuole il metodo non opzionale). */
export type LlmRequestProcessor = Processor & {
  processLLMRequest: NonNullable<Processor['processLLMRequest']>;
};

/** Processore Mastra da passare in `inputProcessors`: interviene solo sul prompt del provider. */
export function createToolResultCompactor(opts: CompactionOptions = {}): LlmRequestProcessor {
  return {
    id: TOOL_RESULT_COMPACTOR_ID,
    name: 'Compattazione dei risultati dei tool',
    processLLMRequest({ prompt, steps, stepNumber }) {
      const keep = currentTurnToolCallIds(steps ?? []);
      const { prompt: next, stats } = compactPrompt(prompt as unknown as ModelPrompt, keep, opts);
      if (stats.compacted === 0) return undefined;
      opts.onCompacted?.({ stepNumber, ...stats });
      return { prompt: next as unknown as typeof prompt };
    },
  };
}
