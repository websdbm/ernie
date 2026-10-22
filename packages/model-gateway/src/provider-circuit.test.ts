import { describe, expect, it, vi } from 'vitest';
import { createProviderCircuit, providerCooldownMs } from './provider-circuit.js';

describe('circuito temporaneo del provider diretto', () => {
  it('salta rifiuti ripetuti, usa una sola sonda e recupera il provider originale', async () => {
    let now = 0;
    const circuit = createProviderCircuit(() => now);
    const primary = vi.fn(async () => {
      throw Object.assign(new Error('overloaded'), { statusCode: 503 });
    });
    const fallback = vi.fn(async () => 'stesso modello via riserva');
    const onFailure = vi.fn();
    expect(await circuit.run(primary, fallback, onFailure)).toContain('riserva');
    for (let i = 0; i < 5; i++) await circuit.run(primary, fallback, onFailure);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(6);
    expect(onFailure).toHaveBeenCalledTimes(1);
    now = 30_001;
    let release: (value: string) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const recovering = circuit.run(probe, fallback, onFailure);
    await circuit.run(probe, fallback, onFailure);
    expect(probe).toHaveBeenCalledTimes(1);
    release('diretto recuperato');
    expect(await recovering).toBe('diretto recuperato');
    const restored = vi.fn(async () => 'diretto');
    expect(await circuit.run(restored, fallback, onFailure)).toBe('diretto');
    expect(restored).toHaveBeenCalledTimes(1);
  });

  it('non apre il circuito per input o credenziali errati e non ripiega dopo cancellazione', async () => {
    expect(providerCooldownMs({ statusCode: 400, message: 'invalid prompt' })).toBeNull();
    expect(providerCooldownMs({ statusCode: 401 })).toBeNull();
    expect(providerCooldownMs({ statusCode: 400, message: 'Your credit balance is too low' })).toBe(
      120_000,
    );
    expect(providerCooldownMs({ statusCode: 429 })).toBe(30_000);
    const circuit = createProviderCircuit();
    const fallback = vi.fn(async () => 'fallback');
    const abort = new DOMException('stop', 'AbortError');
    await expect(
      circuit.run(
        async () => {
          throw abort;
        },
        fallback,
        () => {},
      ),
    ).rejects.toBe(abort);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('una sonda fallita riapre la pausa, senza toccare altri circuiti/modelli', async () => {
    let now = 0;
    const first = createProviderCircuit(() => now);
    const other = createProviderCircuit(() => now);
    const down = vi.fn(async () => {
      throw { statusCode: 402 };
    });
    const fallback = async () => 'riserva';
    await first.run(down, fallback, () => {});
    now = 120_001;
    await first.run(down, fallback, () => {});
    await first.run(down, fallback, () => {});
    expect(down).toHaveBeenCalledTimes(2);
    expect(
      await other.run(
        async () => 'originale',
        fallback,
        () => {},
      ),
    ).toBe('originale');
  });
});
