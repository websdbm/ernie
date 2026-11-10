import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const Instant = z.iso.datetime({ offset: true });
export const Visit = z
  .object({
    id: z.uuid(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000),
    arrival: Instant.nullable().default(null),
    departure: Instant.nullable().default(null),
    observedAt: Instant,
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('it', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict()
  .refine(
    (v) =>
      (v.arrival || v.departure) &&
      (!v.arrival || !v.departure || Date.parse(v.departure) >= Date.parse(v.arrival)),
    'Intervallo visita non valido',
  );
export type Visit = z.infer<typeof Visit>;
export const Place = z.object({
  id: z.uuid(),
  latitude: z.number(),
  longitude: z.number(),
  label: z.string().max(100).default('Luogo da conoscere'),
  purpose: z.string().max(300).default(''),
  frequency: z.enum(['unknown', 'habitual', 'occasional']).default('unknown'),
  confirmedAt: Instant.nullable().default(null),
  linkedPlaceId: z.string().max(100).nullable().default(null),
  excluded: z.boolean().default(false),
  askedAt: Instant.nullable().default(null),
  snoozeUntil: Instant.nullable().default(null),
});
export type HabitPlace = z.infer<typeof Place>;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const HabitState = z.object({
  epoch: z.uuid(),
  collecting: z.boolean(),
  aiAllowed: z.boolean(),
  enabledAt: Instant.nullable(),
  retentionDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  visits: z.array(Visit).max(2000),
  places: z.array(Place).max(300),
  ignoredVisitIds: z.array(z.object({ id: z.uuid(), expiresAt: Instant })).max(5000),
  visitAliases: z.record(z.string(), z.array(z.uuid()).max(20)).default({}),
  observationKey: Digest.default(() => randomBytes(32).toString('hex')),
  forgottenObservations: z
    .array(
      z.object({ arrival: Digest.nullable(), departure: Digest.nullable(), expiresAt: Instant }),
    )
    .max(5000)
    .default([]),
  retainedSince: Instant.nullable().default(null),
  lastReviewDay: z.string().nullable(),
  lastQuestionDay: z.string().nullable(),
  patterns: z
    .array(
      z.object({
        placeId: z.uuid(),
        weekday: z.number().int().min(0).max(6),
        arrivalStart: z.string(),
        arrivalEnd: z.string(),
        days: z.number(),
        spanDays: z.number(),
        updatedAt: Instant,
      }),
    )
    .max(100),
});
export type HabitState = z.infer<typeof HabitState>;
export const initialHabits = (): HabitState => ({
  epoch: randomUUID(),
  collecting: false,
  aiAllowed: false,
  enabledAt: null,
  retentionDays: 30,
  visits: [],
  places: [],
  ignoredVisitIds: [],
  visitAliases: {},
  observationKey: randomBytes(32).toString('hex'),
  forgottenObservations: [],
  retainedSince: null,
  lastReviewDay: null,
  lastQuestionDay: null,
  patterns: [],
});
export const distanceM = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) => {
  const rad = Math.PI / 180,
    lat = (b.latitude - a.latitude) * rad,
    lon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(lat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(lon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};
export const visitPlace = (s: HabitState, v: Visit) => s.places.find((p) => distanceM(p, v) <= 100);
export function credibleVisit(v: Visit) {
  return (
    v.accuracyM <= 100 &&
    v.arrival !== null &&
    v.departure !== null &&
    Date.parse(v.departure) - Date.parse(v.arrival) >= 10 * 60_000
  );
}
export class HabitsModelError extends Error {
  constructor(readonly code: 'invalid_visit_time' | 'visit_identity_changed' | 'habits_capacity') {
    super(code);
  }
}
function observationCell(v: Visit) {
  const lat = (v.latitude * Math.PI) / 180;
  const lon = (v.longitude * Math.PI) / 180;
  return [
    Math.floor((6371000 * Math.cos(lat) * Math.cos(lon)) / 15),
    Math.floor((6371000 * Math.cos(lat) * Math.sin(lon)) / 15),
    Math.floor((6371000 * Math.sin(lat)) / 15),
  ] as const;
}
function observationDigest(s: HabitState, x: number, y: number, z: number, minute: number) {
  return createHmac('sha256', Buffer.from(s.observationKey, 'hex'))
    .update(JSON.stringify(['habits-observation-v1', x, y, z, minute]))
    .digest('hex');
}
export function forgottenObservation(s: HabitState, v: Visit, expiresAt: string) {
  const [x, y, z] = observationCell(v);
  const digest = (instant: string | null) =>
    instant ? observationDigest(s, x, y, z, Math.floor(Date.parse(instant) / 60000)) : null;
  return { arrival: digest(v.arrival), departure: digest(v.departure), expiresAt };
}
function suppressedObservation(s: HabitState, v: Visit) {
  if (!s.forgottenObservations.length) return false;
  const [x, y, z] = observationCell(v);
  const nearby = (instant: string | null) => {
    const digests = new Set<string>();
    if (instant) {
      const minute = Math.floor(Date.parse(instant) / 60000);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (let dt = -1; dt <= 1; dt++)
              digests.add(observationDigest(s, x + dx, y + dy, z + dz, minute + dt));
    }
    return digests;
  };
  // Account-local HMACs remain encrypted, with no tombstone coordinates. Neighboring
  // 15 m ECEF cells/minutes cover small jitter, not arbitrary equivalent inputs.
  // Matches span less than 52 m and 120 s; other visits here remain eligible.
  const arrivals = nearby(v.arrival);
  const departures = nearby(v.departure);
  return s.forgottenObservations.some(
    (f) =>
      (f.arrival !== null && arrivals.has(f.arrival)) ||
      ((!v.arrival || !f.arrival) && f.departure !== null && departures.has(f.departure)),
  );
}
export function pruneHabits(s: HabitState, now: Date) {
  // Increasing retention cannot reopen a time range already purged under a shorter policy.
  const cutoff = Math.max(
    now.getTime() - s.retentionDays * 86400000,
    s.retainedSince ? Date.parse(s.retainedSince) : -Infinity,
  );
  s.retainedSince = new Date(cutoff).toISOString();
  const count = s.visits.length;
  s.visits = s.visits.filter((v) => Date.parse(v.departure ?? v.observedAt) >= cutoff);
  if (s.visits.length !== count) s.patterns = [];
  s.places = s.places.filter(
    (p) => p.confirmedAt || p.excluded || s.visits.some((v) => distanceM(p, v) <= 100),
  );
  s.ignoredVisitIds = s.ignoredVisitIds.filter((v) => Date.parse(v.expiresAt) > now.getTime());
  s.forgottenObservations = s.forgottenObservations.filter(
    (v) => Date.parse(v.expiresAt) > now.getTime(),
  );
  for (const id of Object.keys(s.visitAliases))
    if (!s.visits.some((v) => v.id === id)) delete s.visitAliases[id];
}
export function ingestVisits(s: HabitState, incoming: Visit[], now: Date) {
  pruneHabits(s, now);
  for (const v of incoming) {
    if (
      Date.parse(v.observedAt) > now.getTime() + 300_000 ||
      (v.arrival && Date.parse(v.arrival) > Date.parse(v.observedAt) + 300_000) ||
      (v.departure && Date.parse(v.departure) > Date.parse(v.observedAt) + 300_000)
    )
      throw new HabitsModelError('invalid_visit_time');
    const start = Date.parse(v.arrival ?? v.departure ?? v.observedAt);
    if (
      start < Date.parse(s.enabledAt ?? now.toISOString()) ||
      start < Date.parse(s.retainedSince ?? now.toISOString())
    )
      continue;
    if (
      s.ignoredVisitIds.some((ignored) => ignored.id === v.id) ||
      s.places.some((p) => p.excluded && distanceM(p, v) <= 150) ||
      suppressedObservation(s, v)
    )
      continue;
    // Same arrival from another device is one observation, not evidence of two distinct visits.
    const identityIndex = s.visits.findIndex(
      (old) => old.id === v.id || s.visitAliases[old.id]?.includes(v.id),
    );
    const index =
      identityIndex >= 0
        ? identityIndex
        : s.visits.findIndex(
            (old) =>
              old.arrival &&
              v.arrival &&
              Math.abs(Date.parse(old.arrival) - Date.parse(v.arrival)) < 120000 &&
              distanceM(old, v) < 50,
          );
    if (index >= 0) {
      const old = s.visits[index];
      if (!old) continue;
      if (
        identityIndex >= 0 &&
        (distanceM(old, v) > 500 ||
          (old.arrival &&
            v.arrival &&
            Math.abs(Date.parse(old.arrival) - Date.parse(v.arrival)) >=
              (old.id === v.id ? 1 : 120000)) ||
          (!old.arrival &&
            old.departure &&
            v.departure &&
            Math.abs(Date.parse(old.departure) - Date.parse(v.departure)) >=
              (old.id === v.id ? 1 : 120000)))
      )
        throw new HabitsModelError('visit_identity_changed');
      const merged = {
        ...v,
        id: old.id,
        arrival: old.arrival ?? v.arrival,
        departure: old.departure ?? v.departure,
        observedAt:
          Date.parse(old.observedAt) >= Date.parse(v.observedAt) ? old.observedAt : v.observedAt,
        timezone: old.timezone,
        accuracyM: Math.min(old.accuracyM, v.accuracyM),
        latitude: old.accuracyM <= v.accuracyM ? old.latitude : v.latitude,
        longitude: old.accuracyM <= v.accuracyM ? old.longitude : v.longitude,
      };
      if (!Visit.safeParse(merged).success) throw new HabitsModelError('visit_identity_changed');
      if (old.id !== v.id) {
        const aliases = s.visitAliases[old.id] ?? [];
        if (!aliases.includes(v.id)) {
          if (aliases.length >= 20) throw new HabitsModelError('habits_capacity');
          s.visitAliases[old.id] = [...aliases, v.id];
        }
      }
      if (
        old.arrival !== merged.arrival ||
        old.departure !== merged.departure ||
        old.latitude !== merged.latitude ||
        old.longitude !== merged.longitude ||
        old.accuracyM !== merged.accuracyM
      )
        s.patterns = [];
      s.visits[index] = merged;
    } else {
      if (s.visits.length >= 2000) throw new HabitsModelError('habits_capacity');
      s.visits.push(v);
    }
    const merged = index >= 0 ? (s.visits[index] ?? v) : v;
    if (credibleVisit(merged) && !visitPlace(s, merged)) {
      if (s.places.length >= 300) throw new HabitsModelError('habits_capacity');
      s.places.push(
        Place.parse({ id: randomUUID(), latitude: merged.latitude, longitude: merged.longitude }),
      );
    }
  }
  pruneHabits(s, now);
}
function local(v: Visit) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: v.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(v.arrival as string));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
export function reviewHabits(s: HabitState, now: Date, timezone: string) {
  pruneHabits(s, now);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  if (s.lastReviewDay && s.lastReviewDay >= day) return;
  s.lastReviewDay = day;
  s.patterns = [];
  for (const p of s.places.filter((p) => !p.excluded && p.frequency !== 'occasional')) {
    const visits = s.visits
      .filter((v) => credibleVisit(v) && visitPlace(s, v)?.id === p.id)
      .sort((a, b) => (b.arrival ?? '').localeCompare(a.arrival ?? '') || b.id.localeCompare(a.id))
      .map(local);
    for (let weekday = 0; weekday < 7; weekday++) {
      const distinct = [
        ...new Map(visits.filter((v) => v.weekday === weekday).map((v) => [v.day, v])).values(),
      ].sort((a, b) => a.day.localeCompare(b.day));
      const first = distinct[0],
        last = distinct.at(-1);
      if (distinct.length < 3 || !first || !last) continue;
      const spanDays = (Date.parse(last.day) - Date.parse(first.day)) / 86400000;
      if (spanDays < 14) continue;
      const times = distinct.map((v) => v.minute).sort((a, b) => a - b),
        lo = times[0] ?? 0,
        hi = times.at(-1) ?? 0;
      if (hi - lo > 120) continue; // Irregular days are not a stable routine.
      const hhmm = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      if (s.patterns.length < 100)
        s.patterns.push({
          placeId: p.id,
          weekday,
          arrivalStart: hhmm(lo),
          arrivalEnd: hhmm(hi),
          days: distinct.length,
          spanDays,
          updatedAt: now.toISOString(),
        });
    }
  }
}
export function questionCandidate(s: HabitState, now: Date) {
  return s.places.find(
    (p) =>
      !p.excluded &&
      !p.confirmedAt &&
      (!p.askedAt || (p.snoozeUntil && Date.parse(p.snoozeUntil) <= now.getTime())) &&
      (!p.snoozeUntil || Date.parse(p.snoozeUntil) <= now.getTime()) &&
      s.visits.some((v) => credibleVisit(v) && visitPlace(s, v)?.id === p.id),
  );
}
