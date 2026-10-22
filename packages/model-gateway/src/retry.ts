import { setTimeout as delay } from 'node:timers/promises';

const MAX_RETRY_WAIT_MS = 120_000;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function details(error: unknown) {
  const e = record(error);
  let body: Record<string, unknown> = record(e.data);
  if (typeof e.responseBody === 'string' && e.responseBody.length <= 16_000) {
    try {
      body = record(JSON.parse(e.responseBody));
    } catch {
      // I proxy possono rispondere con HTML: non mostrarlo e non trattarlo come istruzioni.
    }
  }
  const provider = record(body.error ?? body);
  const metadata = record(provider.metadata);
  const status = e.statusCode ?? e.status;
  return { e, metadata, status };
}

/** OpenRouter usa 402 anche per credito temporaneamente riservato ad altre chiamate. */
export function inFlightModelLimit(error: unknown): boolean {
  const { status, metadata } = details(error);
  return status === 402 && metadata.reason === 'in_flight_budget_exhausted';
}

/** Rispetta Retry-After; un'attesa oltre il limite termina senza ritentare in anticipo. */
export function modelRetryDelayMs(
  error: unknown,
  attempt: number,
  now = Date.now(),
): number | null {
  const { e, metadata } = details(error);
  const retryAfter = (headers: unknown) =>
    Object.entries(record(headers)).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const value = retryAfter(e.responseHeaders) ?? retryAfter(metadata.headers);
  if (typeof value === 'string' || typeof value === 'number') {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(String(value)) - now);
    if (Number.isFinite(ms)) return ms <= MAX_RETRY_WAIT_MS ? ms : null;
  }
  return 500 * 2 ** attempt;
}

/** Testi deterministici: disponibili anche quando il modello non riesce a rispondere. */
export function modelFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} | null {
  if (inFlightModelLimit(error))
    return {
      code: 'provider_busy',
      message:
        'Il servizio AI ha temporaneamente raggiunto il limite delle richieste in corso. Riprova fra qualche minuto.',
      retryable: true,
    };
  const { status } = details(error);
  if (status === 402)
    return {
      code: 'provider_credits',
      message:
        'Il credito del servizio AI non è sufficiente per completare la richiesta. Occorre verificare il saldo o il limite di spesa del servizio.',
      retryable: false,
    };
  if (status === 429)
    return {
      code: 'provider_limit',
      message:
        'Il servizio AI ha raggiunto un limite di utilizzo. La richiesta non è stata completata: riprova più tardi.',
      retryable: true,
    };
  return null;
}

/** Errori temporanei della rete o del provider; mai credenziali, input o cancellazioni. */
export function transientModelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    name?: string;
    statusCode?: number;
    status?: number;
    code?: string;
    message?: string;
    cause?: unknown;
  };
  if (e.name === 'AbortError') return false;
  if (inFlightModelLimit(error)) return true;
  const status = e.statusCode ?? e.status;
  if (status !== undefined)
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  return (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(e.code ?? '') ||
    /fetch failed|network error|socket hang up/i.test(e.message ?? '') ||
    (e.cause !== error && transientModelError(e.cause))
  );
}

/** Tre tentativi della singola chiamata, prima che lo stream inizi: nessun tool viene rieseguito. */
export async function retryModelCall<T>(
  call: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (signal?.aborted || attempt >= 2 || !transientModelError(error)) throw error;
      const waitMs = modelRetryDelayMs(error, attempt);
      if (waitMs === null) throw error;
      await delay(waitMs, undefined, { signal });
    }
  }
}
