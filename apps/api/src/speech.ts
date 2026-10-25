import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BudgetGuard, LlmCallRecorder } from '@ernie/model-gateway';
import type { AuthContext } from './auth.js';
import { normalizeSpeechAudio } from './speech-audio.js';

export const SPEECH_MODEL = 'fish-audio/drama-3';
const BEAR_VOICE =
  'Speak Italian as Ernie, a friendly adult male bear. Use a very deep, distinctly hoarse and raspy bass voice, with a coarse gravelly texture, rich chest resonance and an audible low rumble in every phrase. The rasp must be prominent, not a subtle hint. Keep the delivery full-bodied, resonant and clearly projected, with crisp intelligible words and natural pacing. Maintain this same rugged low register throughout. Warm and reassuring, never threatening. No whispering, breathy softness, shouting, animal noises or roaring.';
export const SPEECH_STYLES = {
  warm: `${BEAR_VOICE} Sound affectionate, relaxed and gently humorous.`,
  playful: `${BEAR_VOICE} Sound playfully amused and expressive, keeping the deep register even when excited.`,
  calm: `${BEAR_VOICE} Sound especially calm and reassuring, with measured phrasing while retaining the pronounced rasp and full vocal presence.`,
} as const;
export type SpeechStyle = keyof typeof SPEECH_STYLES;
export class SpeechError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface SpeechOptions {
  readonly apiKey?: string;
  readonly enabled: boolean;
  readonly voiceId?: string | undefined;
  readonly timeoutMs: number;
  /** Stima conservativa da listino, non prezzo promozionale né costo dichiarato dal provider. */
  readonly usdPerMillionBytes: number;
  readonly dailyBudgetUsd: number;
  readonly budget: BudgetGuard;
  readonly recorder: LlmCallRecorder;
  readonly fetch?: typeof fetch;
  readonly processAudio?: typeof normalizeSpeechAudio;
}

export function speechBudget(auth: AuthContext, serverLimit: number): number {
  const own = auth.settings.dailyBudgetUsd;
  const valid = typeof own === 'number' && Number.isFinite(own) && own >= 0;
  if (auth.role === 'owner') return valid ? own : serverLimit;
  return valid && own > 0 ? Math.min(own, serverLimit || own) : serverLimit;
}

/** Un servizio per processo, una richiesta in corso per utente; nessun testo/audio persistito. */
const NOT_SENT = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
/** Errori di fetch in cui il server del fornitore non ha mai ricevuto la richiesta. */
export function connectionNeverOpened(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 4; i++) {
    if (typeof e.code === 'string' && NOT_SENT.has(e.code)) return true;
    e = e.cause as typeof e;
  }
  return false;
}
export function createSpeechService(opts: SpeechOptions) {
  const active = new Set<string>();
  const windows = new Map<string, { at: number; requests: number }>();
  return {
    async synthesize(
      auth: AuthContext,
      text: string,
      style: SpeechStyle,
      signal?: AbortSignal,
    ): Promise<Buffer> {
      if (!opts.enabled || !opts.apiKey)
        throw new SpeechError(503, 'speech_unavailable', 'Voce online non disponibile');
      if (auth.settings.killSwitch === true)
        throw new SpeechError(403, 'disabled', 'Interruttore di emergenza attivo');
      if (!text.trim() || text.length > 2000)
        throw new SpeechError(400, 'invalid_text', 'Testo troppo lungo o vuoto');
      if (active.has(auth.userId))
        throw new SpeechError(429, 'speech_busy', 'Sintesi già in corso');
      const now = Date.now();
      for (const [id, w] of windows) if (now - w.at >= 60_000) windows.delete(id);
      const window = windows.get(auth.userId) ?? { at: now, requests: 0 };
      if (window.requests >= 60 || windows.size >= 10_000)
        throw new SpeechError(429, 'speech_rate_limit', 'Troppe richieste vocali');
      window.requests++;
      windows.set(auth.userId, window);
      active.add(auth.userId);
      const abort = AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(opts.timeoutMs),
      ]);
      const bytes = Buffer.byteLength(`[${SPEECH_STYLES[style]}] ${text}`, 'utf8');
      const estimatedCostUsd = (bytes * opts.usdPerMillionBytes) / 1_000_000;
      const limit = speechBudget(auth, opts.dailyBudgetUsd);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          abort.throwIfAborted();
          const { spentUsd } = await opts.budget.assertWithinBudget(auth.userId, limit);
          if (limit > 0 && spentUsd + estimatedCostUsd > limit)
            throw new SpeechError(429, 'budget_exceeded', 'Budget giornaliero raggiunto');
          const started = Date.now();
          let generationId: string | null = null;
          let finish = 'error';
          let retry = false;
          let sent = false;
          try {
            let response: Response;
            try {
              response = await (opts.fetch ?? fetch)('https://openrouter.ai/api/v1/audio/speech', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${opts.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: SPEECH_MODEL,
                  input: text,
                  instructions: SPEECH_STYLES[style],
                  response_format: 'mp3',
                  ...(opts.voiceId ? { voice: opts.voiceId } : {}),
                }),
                signal: abort,
              });
            } catch (err) {
              // Connessione mai stabilita (DNS, rifiuto, timeout di connessione): la richiesta non è partita e non
              // costa nulla. Un errore a metà (reset, timeout dopo l'invio) resta registrato: potrebbe essere pagato.
              sent = !connectionNeverOpened(err);
              throw err;
            }
            sent = true;
            generationId = response.headers.get('x-generation-id');
            if (!response.ok) {
              retry = response.status === 429 || response.status >= 500;
              await response.body?.cancel();
              throw new SpeechError(
                502,
                'speech_provider_error',
                'Sintesi vocale temporaneamente non disponibile',
              );
            }
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) {
              await response.body?.cancel();
              throw new SpeechError(502, 'invalid_audio', 'Risposta vocale non valida');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new SpeechError(502, 'invalid_audio', 'Risposta vocale vuota');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > 4_000_000)
                  throw new SpeechError(502, 'audio_too_large', 'Risposta vocale troppo lunga');
                chunks.push(part.value);
              }
            } finally {
              await reader.cancel().catch(() => undefined);
            }
            const audio = Buffer.concat(chunks);
            if (
              audio.length < 64 ||
              !(
                audio.subarray(0, 3).toString() === 'ID3' ||
                (audio[0] === 0xff && ((audio[1] ?? 0) & 0xe0) === 0xe0)
              )
            )
              throw new SpeechError(502, 'invalid_audio', 'Formato vocale non valido');
            abort.throwIfAborted();
            finish = 'stop';
            try {
              return await (opts.processAudio ?? normalizeSpeechAudio)(audio, abort);
            } catch {
              // La sintesi è già riuscita: non ripeterla a pagamento per un errore locale.
              throw new SpeechError(
                503,
                'audio_processing_failed',
                'Elaborazione vocale non disponibile',
              );
            }
          } catch (err) {
            if (!(err instanceof SpeechError)) retry = !abort.aborted;
            if (attempt === 1 || !retry || abort.aborted) throw err;
          } finally {
            if (sent)
              await opts.recorder.record({
                userId: auth.userId,
                sessionId: null,
                requestId: `speech:${randomUUID()}`,
                stepIndex: attempt,
                purpose: 'other',
                provider: 'openrouter',
                model: SPEECH_MODEL,
                modelClass: 'tts',
                generationId,
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  reasoningTokens: 0,
                  costReportedUsd: undefined,
                },
                estimatedCostUsd,
                ttftMs: null,
                latencyMs: Date.now() - started,
                finishReason: finish,
              });
          }
          await delay(250, undefined, { signal: abort });
        }
        throw new SpeechError(502, 'speech_provider_error', 'Voce online non disponibile');
      } catch (err) {
        if (err instanceof SpeechError) throw err;
        if (err instanceof Error && err.name === 'BudgetExceededError')
          throw new SpeechError(429, 'budget_exceeded', 'Budget giornaliero raggiunto');
        throw new SpeechError(503, 'speech_unavailable', 'Voce online non disponibile');
      } finally {
        active.delete(auth.userId);
      }
    },
  };
}
export type SpeechService = ReturnType<typeof createSpeechService>;
