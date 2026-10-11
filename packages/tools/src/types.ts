import type { RunContext, ToolRisk } from '@ernie/agent-core';
import type { ContentBlock, EventType, PayloadInputOf } from '@ernie/protocol';
import type { z } from 'zod';

export type { ToolRisk };

/** Contesto di esecuzione per turno: aggiornato dalla connessione prima di ogni turno. */
export interface ToolContext {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
  readonly scopes: readonly string[];
  readonly run: RunContext;
  readonly emit?: <T extends EventType>(
    type: T,
    payload: PayloadInputOf<T>,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
  /** Chiamato quando la run viene contaminata: la connessione lo propaga alla sessione (persistente). */
  readonly onTainted?: (source: string) => void;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
}

/** Un tool con i metadati richiesti dall'architettura (§9): identità, rischio, permessi, limiti, costo. */
export interface ToolSpec<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Identificativo stabile, [a-z0-9_]: diventa il nome della funzione per il modello. */
  readonly id: string;
  readonly version: string;
  readonly category: string;
  /** Una frase: ciò che il modello vede. */
  readonly description: string;
  readonly risk: ToolRisk;
  readonly requiredScopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly costEstimateUsd?: number;
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly execute: (input: z.infer<I>, ctx: ToolContext) => Promise<z.infer<O>>;
  /** Etichetta della sorgente non fidata introdotta dall'output (per il taint), se applicabile. */
  readonly untrustedSource?: (input: z.infer<I>, output: z.infer<O>) => string | null;
  /** Blocco strutturato da mostrare al client come scheda (protocollo v1.2), derivato dall'esito. */
  readonly present?: (
    input: z.infer<I>,
    output: z.infer<O>,
  ) => ContentBlock | readonly ContentBlock[] | null;
}

export class ToolError extends Error {
  override readonly name = 'ToolError';
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Dichiara un tool con inferenza dei tipi di input/output e lo restituisce nel tipo largo del registry. */
export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: ToolSpec<I, O>,
): ToolSpec {
  return spec as unknown as ToolSpec;
}
