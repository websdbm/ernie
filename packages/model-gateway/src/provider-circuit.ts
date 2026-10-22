import { transientModelError } from './retry.js';

/** Solo indisponibilità del provider: un prompt errato non disabilita il servizio per gli altri turni. */
export function providerCooldownMs(error: unknown): number | null {
  const e =
    error && typeof error === 'object'
      ? (error as {
          name?: string;
          statusCode?: number;
          status?: number;
          message?: string;
          responseBody?: string;
        })
      : {};
  if (e.name === 'AbortError') return null;
  const status = e.statusCode ?? e.status;
  if (
    status === 402 ||
    (status === 400 &&
      /credit balance|insufficient credits/i.test(`${e.message ?? ''} ${e.responseBody ?? ''}`))
  )
    return 120_000;
  return transientModelError(error) ? 30_000 : null;
}

/** Circuito per istanza gateway e modello: una sola sonda dopo la pausa, senza attese aggiunte. */
export function createProviderCircuit(now: () => number = Date.now) {
  let until = 0;
  let probing = false;
  let epoch = 0;
  return {
    async run<T>(
      primary: () => PromiseLike<T>,
      fallback: () => PromiseLike<T>,
      onFailure: (error: unknown) => void,
      signal?: AbortSignal,
    ): Promise<T> {
      signal?.throwIfAborted();
      if (until > now() || probing) return fallback();
      const probe = until > 0;
      const startedEpoch = epoch;
      if (probe) probing = true;
      try {
        const result = await primary();
        if (probe && epoch === startedEpoch) until = 0;
        return result;
      } catch (error) {
        if (signal?.aborted || (error as { name?: string } | null)?.name === 'AbortError')
          throw error;
        const cooldown = providerCooldownMs(error);
        if (cooldown !== null) {
          until = now() + cooldown;
          epoch++;
        }
        onFailure(error);
        return await fallback();
      } finally {
        if (probe) probing = false;
      }
    },
  };
}
