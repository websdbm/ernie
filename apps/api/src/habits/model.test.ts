import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ingestVisits,
  initialHabits,
  pruneHabits,
  questionCandidate,
  reviewHabits,
  Visit,
} from './model.js';

const now = new Date('2026-11-10T12:00:00Z');
const state = () => ({
  ...initialHabits(),
  collecting: true,
  enabledAt: '2026-09-01T00:00:00Z',
  retentionDays: 90 as const,
});
const visit = (arrival = '2026-11-10T09:00:00Z', patch: Partial<Visit> = {}): Visit => ({
  id: randomUUID(),
  latitude: 45,
  longitude: 12,
  accuracyM: 20,
  arrival,
  departure: new Date(Date.parse(arrival) + 3600000).toISOString(),
  observedAt: now.toISOString(),
  timezone: 'Europe/Rome',
  ...patch,
});
describe('Abitudini observation and inference boundaries', () => {
  it('off by default and rejects invalid observations', () => {
    expect(initialHabits()).toMatchObject({ collecting: false, aiAllowed: false, visits: [] });
    expect(Visit.safeParse(visit(undefined, { latitude: 91 })).success).toBe(false);
    expect(Visit.safeParse(visit(undefined, { arrival: null, departure: null })).success).toBe(
      false,
    );
  });
  it('ignores pre-consent observations and rejects future timestamps', () => {
    const s = state();
    s.enabledAt = now.toISOString();
    ingestVisits(s, [visit()], now);
    expect(s.visits).toHaveLength(0);
    expect(() =>
      ingestVisits(s, [visit(undefined, { observedAt: '2027-01-01T00:00:00Z' })], now),
    ).toThrow();
  });
  it('retries and devices count as one observation; remembers aliases', () => {
    const s = state(),
      a = visit(),
      b = visit();
    ingestVisits(s, [a, a, b], now);
    expect(s.visits).toHaveLength(1);
    expect(s.visitAliases[a.id]).toEqual([b.id]);
  });
  it('partial updates preserve completed visit and best coordinate accuracy', () => {
    const s = state(),
      a = visit();
    ingestVisits(s, [a, { ...a, departure: null, latitude: 45.0002, accuracyM: 90 }], now);
    expect(s.visits[0]).toMatchObject({
      departure: a.departure,
      latitude: a.latitude,
      accuracyM: 20,
    });
  });
  it('does not classify short or imprecise visits', () => {
    const s = state();
    ingestVisits(
      s,
      [
        visit(undefined, { accuracyM: 600 }),
        visit('2026-11-10T11:00:00Z', { departure: '2026-11-10T11:01:00Z' }),
      ],
      now,
    );
    expect(s.places).toHaveLength(0);
    reviewHabits(s, now, 'Europe/Rome');
    expect(s.patterns).toHaveLength(0);
  });
  it('retention removes unconfirmed coordinates and invalidates unsupported patterns', () => {
    const s = state();
    ingestVisits(s, [visit()], now);
    s.patterns.push({
      placeId: s.places[0]?.id ?? 'missing-place',
      weekday: 2,
      arrivalStart: '10:00',
      arrivalEnd: '10:00',
      days: 3,
      spanDays: 14,
      updatedAt: now.toISOString(),
    });
    pruneHabits(s, new Date('2027-03-01T00:00:00Z'));
    expect(s.visits).toHaveLength(0);
    expect(s.places).toHaveLength(0);
    expect(s.patterns).toHaveLength(0);
  });
  it('requires three distinct weeks and reviews once per day', () => {
    const s = state();
    ingestVisits(s, [visit('2026-10-27T09:00:00Z'), visit('2026-11-03T09:00:00Z'), visit()], now);
    reviewHabits(s, now, 'Europe/Rome');
    expect(s.patterns).toHaveLength(1);
    s.patterns = [];
    reviewHabits(s, now, 'Europe/Rome');
    expect(s.patterns).toHaveLength(0);
  });
  it('inference does not depend on upload order and chooses first visit of day', () => {
    const data = [
      visit('2026-10-27T09:00:00Z'),
      visit('2026-10-27T15:00:00Z'),
      visit('2026-11-03T09:00:00Z'),
      visit(),
    ];
    const a = state(),
      b = state();
    ingestVisits(a, data, now);
    ingestVisits(b, [...data].reverse(), now);
    reviewHabits(a, now, 'Europe/Rome');
    reviewHabits(b, now, 'Europe/Rome');
    expect(a.patterns.map(({ placeId, ...p }) => p)).toEqual(
      b.patterns.map(({ placeId, ...p }) => p),
    );
    expect(a.patterns).toHaveLength(1);
  });
  it('later can become eligible again, exclusion prevents reimport', () => {
    const s = state();
    ingestVisits(s, [visit()], now);
    const p = s.places[0];
    if (!p) throw new Error('missing fixture place');
    p.askedAt = now.toISOString();
    p.snoozeUntil = '2026-11-11T12:00:00Z';
    expect(questionCandidate(s, now)).toBeUndefined();
    expect(questionCandidate(s, new Date('2026-11-12T12:00:00Z'))?.id).toBe(p.id);
    p.excluded = true;
    s.visits = [];
    ingestVisits(s, [visit()], now);
    expect(s.visits).toHaveLength(0);
  });
});
