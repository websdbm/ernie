import { describe, expect, it, vi } from 'vitest';
import { createProviderBalance, currentUsageDate, UsageQuery, usageModelLabel } from './usage.js';

describe('richieste dei consumi', () => {
  it('valida date reali, periodi e fusi senza accettare chiavi aggiuntive', () => {
    expect(UsageQuery.parse({})).toEqual({ period: 'month', timezone: 'Europe/Rome' });
    for (const query of [
      { date: '2026-02-30' },
      { timezone: 'Europe/Inventato' },
      { timezone: '+01:00' },
      { period: "day'); DROP TABLE users;--" },
      { userId: 'altro' },
      { accountId: 'non-uuid' },
    ])
      expect(UsageQuery.safeParse(query).success).toBe(false);
    expect(
      UsageQuery.parse({ date: '2024-02-29', period: 'week', timezone: 'Pacific/Auckland' }).date,
    ).toBe('2024-02-29');
    expect(UsageQuery.parse({ timezone: 'CET' }).timezone).toBe('Europe/Brussels');
    expect(UsageQuery.parse({ timezone: 'GMT' }).timezone).toBe('UTC');
  });

  it('usa il giorno locale al cambio data e etichette comprensibili', () => {
    const instant = new Date('2026-10-20T22:30:00Z');
    expect(currentUsageDate('Europe/Rome', instant)).toBe('2026-10-21');
    expect(currentUsageDate('America/New_York', instant)).toBe('2026-10-20');
    expect(usageModelLabel('anthropic/claude-sonnet-5.5')).toBe('Claude Sonnet 5.5');
    expect(usageModelLabel('typesafe/jev-1.13-20260917')).toBe('Jev');
  });
});

describe('saldo condiviso del provider', () => {
  it('usa il saldo effettivo, cache limitata e un solo accesso per richieste concorrenti', async () => {
    let date = new Date('2026-10-20T12:00:00Z');
    const fetcher = vi.fn(async () =>
      Response.json({ data: { total_credits: 58, total_usage: 57.8 } }),
    );
    const balance = createProviderBalance('test-secret', fetcher, () => date);
    const [a, b] = await Promise.all([balance(), balance()]);
    expect(a).toEqual(b);
    expect(a.status).toBe('available');
    expect(a.balanceUsd).toBeCloseTo(0.2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(a)).not.toContain('test-secret');
    date = new Date('2026-10-20T12:01:01Z');
    await balance();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('un servizio irraggiungibile non diventa un saldo zero', async () => {
    for (const fetcher of [
      vi.fn(async () => new Response('upstream failure', { status: 502 })),
      vi.fn(async () => Response.json({ data: { total_credits: '58' } })),
    ]) {
      const result = await createProviderBalance('test', fetcher)();
      expect(result.status).toBe('unavailable');
      expect(result.balanceUsd).toBeUndefined();
    }
    const fetcher = vi.fn();
    expect((await createProviderBalance(undefined, fetcher)()).status).toBe('not_configured');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
