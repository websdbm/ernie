import type { PayloadInputOf } from '@ernie/protocol';

/** Sottoinsieme dei chunk di Mastra (`fullStream`) che il runtime interpreta. */
export interface MastraChunkLike {
  readonly type: string;
  readonly payload?: unknown;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export type TurnSignal =
  | { kind: 'text'; delta: string }
  | { kind: 'tool.started'; payload: PayloadInputOf<'tool.started'> }
  | { kind: 'tool.completed'; payload: PayloadInputOf<'tool.completed'> }
  | {
      kind: 'step';
      usage: unknown;
      providerMetadata: unknown;
      responseId: string | undefined;
      finishReason: string | undefined;
    }
  | { kind: 'finish'; finishReason: string | undefined }
  | { kind: 'error'; error: unknown }
  | { kind: 'ignore' };

function preview(v: unknown, max = 300): string | undefined {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Traduce un chunk Mastra in un segnale del turno. Puro e testabile. */
export function interpretChunk(
  chunk: MastraChunkLike,
  toolStartedAt: Map<string, number>,
  now = Date.now(),
): TurnSignal {
  const p = rec(chunk.payload);
  switch (chunk.type) {
    case 'text-delta': {
      const delta = str(p.text) ?? '';
      return delta ? { kind: 'text', delta } : { kind: 'ignore' };
    }
    case 'tool-call': {
      const toolCallId = str(p.toolCallId) ?? 'unknown';
      toolStartedAt.set(toolCallId, now);
      const payload: PayloadInputOf<'tool.started'> = {
        toolCallId,
        toolId: str(p.toolName) ?? 'unknown',
      };
      const argsPreview = preview(p.args);
      return { kind: 'tool.started', payload: argsPreview ? { ...payload, argsPreview } : payload };
    }
    case 'tool-result':
    case 'tool-error': {
      const toolCallId = str(p.toolCallId) ?? 'unknown';
      const started = toolStartedAt.get(toolCallId) ?? now;
      toolStartedAt.delete(toolCallId);
      const result = rec(p.result);
      // L'executor restituisce error/reason/retryable come risultato normale per il modello.
      const toolFailure =
        typeof result.error === 'string' &&
        typeof result.reason === 'string' &&
        typeof result.retryable === 'boolean';
      const isError = chunk.type === 'tool-error' || p.isError === true || toolFailure;
      const payload: PayloadInputOf<'tool.completed'> = {
        toolCallId,
        toolId: str(p.toolName) ?? 'unknown',
        ok: !isError,
        durationMs: Math.max(0, now - started),
      };
      const resultPreview = isError ? undefined : preview(p.result);
      const error = isError
        ? preview(toolFailure ? result.reason : (p.error ?? p.result))
        : undefined;
      return {
        kind: 'tool.completed',
        payload: {
          ...payload,
          ...(resultPreview ? { resultPreview } : {}),
          ...(error ? { error } : {}),
        },
      };
    }
    case 'step-finish': {
      const output = rec(p.output);
      const response = rec(p.response);
      const stepResult = rec(p.stepResult);
      return {
        kind: 'step',
        usage: output.usage ?? p.totalUsage,
        providerMetadata: p.providerMetadata ?? output.providerMetadata,
        responseId: str(response.id),
        finishReason: str(stepResult.reason),
      };
    }
    case 'finish':
      return { kind: 'finish', finishReason: str(rec(p.stepResult).reason) };
    case 'error':
      return { kind: 'error', error: p.error };
    default:
      return { kind: 'ignore' };
  }
}

/** Mappa il finishReason di Mastra sul vocabolario del protocollo. */
export function mapFinishReason(
  reason: string | undefined,
): 'stop' | 'length' | 'tool' | 'cancelled' | 'error' {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
    case 'tool_calls':
      return 'tool';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}
