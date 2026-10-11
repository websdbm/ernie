import { describe, expect, it } from 'vitest';
import {
  dedupeKeys,
  isTooLate,
  jitterMs,
  nextOccurrences,
  previousOccurrence,
  TriggerValidationError,
  validateTrigger,
} from './schedule.js';

// Sabato 17 ottobre 2026, 10:00 a Roma (CEST, UTC+2) = 08:00Z.
const SAT_10_ROME = '2026-10-17T08:00:00.000Z';

describe('previousOccurrence (istante pianificato canonico)', () => {
  it('due scheduler con ritardi diversi calcolano lo stesso istante e la stessa chiave', () => {
    const a = previousOccurrence('0 10 * * 6', 'Europe/Rome', new Date('2026-10-17T08:00:03Z'));
    const b = previousOccurrence('0 10 * * 6', 'Europe/Rome', new Date('2026-10-17T08:00:41Z'));
    expect(a.toISOString()).toBe(SAT_10_ROME);
    expect(dedupeKeys.cron(a)).toBe(dedupeKeys.cron(b));
  });
  it('tick esattamente allo scoccare e tick molto in ritardo danno lo stesso istante', () => {
    expect(
      previousOccurrence('0 10 * * 6', 'Europe/Rome', new Date(SAT_10_ROME)).toISOString(),
    ).toBe(SAT_10_ROME);
    expect(
      previousOccurrence(
        '0 10 * * 6',
        'Europe/Rome',
        new Date('2026-10-17T08:40:00Z'),
      ).toISOString(),
    ).toBe(SAT_10_ROME);
  });
  it('rispetta il fuso: a fine ottobre Roma torna a UTC+1', () => {
    const d = previousOccurrence('0 10 * * 6', 'Europe/Rome', new Date('2026-10-31T09:00:05Z'));
    expect(d.toISOString()).toBe('2026-10-31T09:00:00.000Z');
  });
});

describe('validateTrigger', () => {
  it('accetta un cron settimanale di giorno e una tantum futura', () => {
    expect(() =>
      validateTrigger({ type: 'cron', pattern: '0 10 * * 6' }, 'Europe/Rome'),
    ).not.toThrow();
    expect(() =>
      validateTrigger(
        { type: 'once', at: '2030-05-01T10:00:00.000Z' },
        'Europe/Rome',
        new Date('2026-10-11T00:00:00Z'),
      ),
    ).not.toThrow();
    expect(() => validateTrigger({ type: 'webhook' }, 'Europe/Rome')).not.toThrow();
  });
  it('rifiuta la fascia notturna 01:00–03:59 nel fuso dell’automazione', () => {
    expect(() => validateTrigger({ type: 'cron', pattern: '30 2 * * *' }, 'Europe/Rome')).toThrow(
      TriggerValidationError,
    );
    // 00:30Z = 02:30 a Roma in estate (CEST).
    expect(() =>
      validateTrigger(
        { type: 'once', at: '2027-07-01T00:30:00.000Z' },
        'Europe/Rome',
        new Date('2026-10-11T00:00:00Z'),
      ),
    ).toThrow(/notturna/);
    // Lo stesso istante UTC a Tokyo è 09:30: ammesso.
    expect(() =>
      validateTrigger(
        { type: 'once', at: '2027-07-01T00:30:00.000Z' },
        'Asia/Tokyo',
        new Date('2026-10-11T00:00:00Z'),
      ),
    ).not.toThrow();
  });
  it('rifiuta intervalli sotto i 5 minuti, pattern e fusi non validi, istanti passati', () => {
    expect(() => validateTrigger({ type: 'cron', pattern: '*/2 * * * *' }, 'Europe/Rome')).toThrow(
      /5 minuti/,
    );
    expect(() => validateTrigger({ type: 'cron', pattern: 'ogni tanto' }, 'Europe/Rome')).toThrow(
      /non valido/,
    );
    expect(() => validateTrigger({ type: 'cron', pattern: '0 10 * * 6' }, 'Marte/Olympus')).toThrow(
      /fuso/,
    );
    expect(() =>
      validateTrigger({ type: 'once', at: '2020-01-01T10:00:00.000Z' }, 'Europe/Rome'),
    ).toThrow(/passato/);
  });
});

describe('nextOccurrences, isTooLate, jitterMs', () => {
  it('elenca le prossime occorrenze nel fuso', () => {
    const next = nextOccurrences('0 18 * * *', 'Europe/Rome', new Date('2026-10-11T10:00:00Z'), 2);
    expect(next.map((d) => d.toISOString())).toEqual([
      '2026-10-11T16:00:00.000Z',
      '2026-10-12T16:00:00.000Z',
    ]);
  });
  it('la tolleranza somma jitter e soglia configurata', () => {
    const scheduled = new Date(SAT_10_ROME);
    expect(isTooLate(scheduled, new Date('2026-10-17T08:10:00Z'), 300, 900)).toBe(false);
    expect(isTooLate(scheduled, new Date('2026-10-17T08:21:00Z'), 300, 900)).toBe(true);
  });
  it('il jitter è limitato e deterministico dato il generatore', () => {
    expect(jitterMs(0)).toBe(0);
    expect(jitterMs(300, () => 0.5)).toBe(150_000);
    expect(jitterMs(300, () => 0.999)).toBeLessThan(300_000);
  });
});
