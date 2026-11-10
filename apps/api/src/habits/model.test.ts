import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  forgottenObservation,
  HabitState,
  ingestVisits,
  initialHabits,
  pruneHabits,
  questionCandidate,
  reviewHabits,
  Visit,
} from './model.js';

const now = new Date('2026-11-10T12:00:00Z');
const state = (): HabitState => ({
  ...initialHabits(),
  collecting: true,
  enabledAt: '2026-09-01T00:00:00Z',
  retentionDays: 90,
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
    ingestVisits(
      s,
      [
        a,
        {
          ...a,
          departure: null,
          latitude: 45.0002,
          accuracyM: 90,
          observedAt: '2026-11-10T11:00:00Z',
          timezone: 'Pacific/Honolulu',
        },
      ],
      now,
    );
    expect(s.visits[0]).toMatchObject({
      departure: a.departure,
      latitude: a.latitude,
      accuracyM: 20,
      observedAt: a.observedAt,
      timezone: a.timezone,
    });
  });
  it('suppresses unseen IDs and small cross-cell jitter without excluding other visits', () => {
    const s = state();
    const a = visit('2026-11-10T09:00:59Z');
    s.forgottenObservations.push(forgottenObservation(s, a, '2026-12-01T00:00:00Z'));
    const later = visit('2026-11-10T11:00:00Z');
    const elsewhere = visit(a.arrival ?? undefined, { latitude: 45.01 });
    ingestVisits(
      s,
      [
        { ...a, id: randomUUID() },
        visit('2026-11-10T09:01:01Z', { latitude: 45.00002, longitude: 12.00002 }),
        { ...a, id: randomUUID(), arrival: null },
        later,
        elsewhere,
      ],
      now,
    );
    expect(s.visits.map((v) => v.id)).toEqual([later.id, elsewhere.id]);
  });
  it('suppresses completed retries of forgotten departure-only observations', () => {
    const s = state();
    const a = visit(undefined, { arrival: null });
    s.forgottenObservations.push(forgottenObservation(s, a, '2026-12-01T00:00:00Z'));
    ingestVisits(s, [visit()], now);
    expect(s.visits).toHaveLength(0);
  });
  it('does not equate distinct known arrivals merely because their departures match', () => {
    const s = state();
    const a = visit();
    s.forgottenObservations.push(forgottenObservation(s, a, '2026-12-01T00:00:00Z'));
    const other = visit('2026-11-10T09:30:00Z', { departure: a.departure });
    ingestVisits(s, [other], now);
    expect(s.visits).toEqual([other]);
  });
  it('expires observation fingerprints and scopes them to a private state key', () => {
    const s = state();
    const a = visit();
    s.forgottenObservations.push(forgottenObservation(s, a, now.toISOString()));
    expect(forgottenObservation(state(), a, now.toISOString()).arrival).not.toBe(
      s.forgottenObservations[0]?.arrival,
    );
    ingestVisits(s, [a], now);
    expect(s.forgottenObservations).toEqual([]);
    expect(s.visits).toEqual([a]);
  });
  it('validates known aliases before geographic matching and rejects identity changes', () => {
    const s = state();
    const a = visit();
    const b = visit('2026-11-10T11:00:00Z');
    const alias = { ...b, id: randomUUID() };
    ingestVisits(s, [a, b, alias], now);
    const before = structuredClone(s);
    expect(() => ingestVisits(s, [{ ...alias, arrival: a.arrival }], now)).toThrow(
      'visit_identity_changed',
    );
    expect(s).toEqual(before);
    expect(() => ingestVisits(s, [{ ...alias, latitude: 46, accuracyM: 1 }], now)).toThrow(
      'visit_identity_changed',
    );
    expect(s).toEqual(before);
  });
  it('rejects invalid merged intervals before recording an alias or changing evidence', () => {
    const s = state();
    const a = visit(undefined, { departure: null });
    ingestVisits(s, [a], now);
    const before = structuredClone(s);
    const b = visit('2026-11-10T08:59:00Z', { departure: '2026-11-10T08:59:30Z' });
    expect(Visit.safeParse(b).success).toBe(true);
    expect(() => ingestVisits(s, [b], now)).toThrow('visit_identity_changed');
    expect(s).toEqual(before);
    expect(HabitState.safeParse(s).success).toBe(true);
  });
  it('does not let a completed retry change the identity of a departure-only visit', () => {
    const s = state();
    const a = visit(undefined, { arrival: null });
    ingestVisits(s, [a], now);
    const before = structuredClone(s);
    expect(() => ingestVisits(s, [visit('2026-11-10T07:00:00Z', { id: a.id })], now)).toThrow(
      'visit_identity_changed',
    );
    expect(s).toEqual(before);
  });
  it.each([false, true])(
    'invalidates refined evidence, retaining only explicitly confirmed orphan places (confirmed=%s)',
    (confirmed) => {
      const s = state();
      const data = [
        visit('2026-10-27T09:00:00Z', { accuracyM: 50 }),
        visit('2026-11-03T09:00:00Z', { accuracyM: 50 }),
        visit(undefined, { accuracyM: 50 }),
      ];
      ingestVisits(s, data, now);
      reviewHabits(s, now, 'Europe/Rome');
      expect(s.patterns).toHaveLength(1);
      const oldPlace = s.places[0];
      if (!oldPlace) throw new Error('missing fixture place');
      if (confirmed) {
        oldPlace.confirmedAt = now.toISOString();
        oldPlace.purpose = 'Lavoro';
      }
      ingestVisits(
        s,
        data.map((v) => ({ ...v, latitude: 45.002, accuracyM: 5 })),
        now,
      );
      expect(s.patterns).toEqual([]);
      expect(s.places).toHaveLength(confirmed ? 2 : 1);
      expect(s.places.some((p) => p.id === oldPlace.id)).toBe(confirmed);
      if (confirmed) expect(s.places.find((p) => p.id === oldPlace.id)?.purpose).toBe('Lavoro');
    },
  );
  it('does not reimport expired evidence after retention is increased', () => {
    const s = state();
    const a = visit('2026-10-27T09:00:00Z');
    ingestVisits(s, [a], now);
    s.retentionDays = 7;
    pruneHabits(s, now);
    s.retentionDays = 90;
    ingestVisits(s, [a, { ...a, id: randomUUID() }], now);
    expect(s.visits).toEqual([]);
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
