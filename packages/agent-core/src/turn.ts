import { type LlmCallRecorder, normalizeUsage } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import type { EventType, PayloadInputOf, RouteKind } from '@ernie/protocol';
import type { z } from 'zod';
import type { CompanionAgent } from './agent.js';
import { interpretChunk, mapFinishReason } from './chunks.js';
import { StuckDetector } from './loop.js';

export type Route = z.infer<typeof RouteKind>;

export interface TurnDecision {
  readonly route: Route;
  readonly modelClass: 'light' | 'standard' | 'heavy';
  readonly source: 'deterministic' | 'jev' | 'cache' | 'fallback';
  readonly costUsd: number;
  readonly inputTokens: number;
}

export interface TurnInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly text: string;
  readonly inputMode: 'text' | 'voice';
  readonly companion: CompanionAgent;
  /** Decisione del router (metriche nell'evento finale); assente nei test minimi. */
  readonly decision?: TurnDecision;
  readonly abortSignal: AbortSignal;
  readonly recorder: LlmCallRecorder;
  readonly logger: Logger;
  /** Emette un evento del protocollo verso il client (ordinamento e persistenza a carico del chiamante). */
  readonly emit: <T extends EventType>(type: T, payload: PayloadInputOf<T>) => Promise<void> | void;
}

export interface TurnResult {
  readonly text: string;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly latencyMs: number;
  readonly cancelled: boolean;
  readonly costUsd: number;
  readonly loopDetected: boolean;
}

/** Il turno utente porta le parti variabili (modalità) fuori dal prefisso stabile. */
export function formatUserTurn(text: string, inputMode: 'text' | 'voice'): string {
  return inputMode === 'voice' ? `[voce] ${text}` : text;
}

/**
 * Esegue un turno: stream Mastra → eventi del protocollo; una riga llm_calls per step;
 * limiti hard da profilo; rilevamento di loop; cancellazione via AbortSignal.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { companion, emit, logger } = input;
  const t0 = Date.now();
  let firstTokenAt: number | undefined;
  let stepIndex = 0;
  let toolCalls = 0;
  let text = '';
  let costUsd = 0;
  let loopDetected = false;
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  let lastFinish: string | undefined;
  const toolStartedAt = new Map<string, number>();
  const stuck = new StuckDetector();
  // Abort interno (loop) unito a quello esterno (cancellazione dell'utente).
  const internal = new AbortController();
  const onExternalAbort = () => internal.abort();
  input.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

  const result = (cancelled: boolean): TurnResult => ({
    text,
    llmCalls: stepIndex,
    toolCalls,
    latencyMs: Date.now() - t0,
    cancelled,
    costUsd,
    loopDetected,
  });
  const finishWithLoop = async (): Promise<TurnResult> => {
    await emit('error', {
      code: 'loop_detected',
      message: 'Interrotto: la stessa azione si ripeteva senza progressi',
      retryable: false,
    });
    await emit('assistant.completed', { finishReason: 'error' });
    return result(false);
  };

  await emit('assistant.started', {
    route: input.decision?.route ?? ('llm' as Route),
    modelClass: companion.profile.modelClass,
  });

  try {
    const stream = await companion.agent.stream(formatUserTurn(input.text, input.inputMode), {
      memory: { thread: input.sessionId, resource: input.userId },
      maxSteps: companion.profile.maxSteps,
      modelSettings: { maxOutputTokens: companion.profile.maxOutputTokens },
      abortSignal: internal.signal,
    });

    for await (const chunk of stream.fullStream) {
      if (internal.signal.aborted) break;
      const signal = interpretChunk(chunk as { type: string; payload?: unknown }, toolStartedAt);
      if (
        signal.kind === 'tool.started' &&
        stuck.check(signal.payload.toolId, signal.payload.argsPreview) === 'stuck'
      ) {
        loopDetected = true;
        internal.abort();
        logger.warn(
          { correlationId: input.correlationId, toolId: signal.payload.toolId },
          'loop rilevato: turno interrotto',
        );
        break;
      }
      switch (signal.kind) {
        case 'text':
          firstTokenAt ??= Date.now();
          text += signal.delta;
          await emit('assistant.text.delta', { delta: signal.delta });
          break;
        case 'tool.started':
          toolCalls++;
          await emit('tool.started', signal.payload);
          break;
        case 'tool.completed':
          await emit('tool.completed', signal.payload);
          break;
        case 'step': {
          const usage = normalizeUsage(signal.usage, signal.providerMetadata);
          costUsd += usage.costReportedUsd ?? 0;
          totals.inputTokens += usage.inputTokens;
          totals.outputTokens += usage.outputTokens;
          totals.cachedInputTokens += usage.cacheReadTokens;
          totals.reasoningTokens += usage.reasoningTokens;
          await input.recorder.record({
            userId: input.userId,
            sessionId: input.sessionId,
            requestId: input.correlationId,
            stepIndex,
            purpose: 'turn',
            provider: companion.provider,
            model: companion.profile.modelId,
            modelClass: companion.profile.modelClass,
            generationId: signal.responseId ?? null,
            usage,
            ttftMs: stepIndex === 0 && firstTokenAt ? firstTokenAt - t0 : null,
            latencyMs: Date.now() - t0,
            finishReason: signal.finishReason ?? null,
          });
          stepIndex++;
          break;
        }
        case 'finish':
          lastFinish = signal.finishReason;
          break;
        case 'error':
          throw signal.error instanceof Error ? signal.error : new Error(String(signal.error));
        default:
          break;
      }
    }
  } catch (err) {
    if (input.abortSignal.aborted) {
      await emit('assistant.cancelled', { reason: 'user' });
      return result(true);
    }
    if (loopDetected) return finishWithLoop();
    logger.error({ err, correlationId: input.correlationId }, 'turno fallito');
    await emit('error', {
      code: 'turn_failed',
      message: 'Il turno non è stato completato',
      retryable: true,
    });
    await emit('assistant.completed', { finishReason: 'error' });
    return result(false);
  } finally {
    input.abortSignal.removeEventListener('abort', onExternalAbort);
  }

  if (input.abortSignal.aborted) {
    await emit('assistant.cancelled', { reason: 'user' });
    return result(true);
  }
  if (loopDetected) return finishWithLoop();

  const latencyMs = Date.now() - t0;
  await emit('assistant.text.completed', { text });
  await emit('assistant.completed', {
    finishReason: mapFinishReason(lastFinish),
    usage: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      reasoningTokens: totals.reasoningTokens,
      routerTokens: input.decision?.inputTokens ?? 0,
      llmCalls: stepIndex,
      toolCalls,
      latencyMs,
      costUsdActual: costUsd + (input.decision?.costUsd ?? 0),
      model: companion.profile.modelId,
      route: input.decision?.route ?? 'llm',
    },
  });
  return result(false);
}
