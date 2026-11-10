import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHealthCipher } from '../health-protection/crypto.js';
import { forgottenObservation, HabitState } from './model.js';
import { habitsRoutes } from './routes.js';
import { createHabitsService } from './service.js';

const url = process.env.HABITS_TEST_DATABASE_URL;
const local = Boolean(
  url &&
    new URL(url).hostname === '127.0.0.1' &&
    new URL(url).port === '62204' &&
    new URL(url).pathname === '/ernie',
);
describe.skipIf(!local)('Abitudini encrypted runtime with real RLS and HTTP', () => {
  let owner: Pool, app: Pool;
  const users: string[] = [];
  const cipher = createHealthCipher({
    activeKeyId: 'synthetic',
    keys: new Map([['synthetic', Buffer.alloc(32, 42)]]),
  });
  const user = async (enabled = true) => {
    const id = randomUUID();
    users.push(id);
    await owner.query('INSERT INTO users(id,display_name,settings) VALUES($1,$2,$3)', [
      id,
      'Habits synthetic fixture',
      { skills: { abitudini: enabled }, proactive: true },
    ]);
    return id;
  };
  const clock = () => new Date('2026-11-10T12:00:00Z');
  const setup = (now = clock) =>
    createHabitsService({ pool: app, cipher, places: async () => [], now });
  const configure = async (s: ReturnType<typeof setup>, id: string, ai = false) => {
    const state = await s.get(id);
    return s.configure(id, {
      expectedRevision: state.revision,
      collecting: true,
      aiAllowed: ai,
      retentionDays: 30,
      policyVersion: 1,
    });
  };
  const observation = (id = randomUUID()) => ({
    id,
    latitude: 45,
    longitude: 12,
    accuracyM: 10,
    arrival: '2026-11-10T12:01:00Z',
    departure: '2026-11-10T12:20:00Z',
    observedAt: '2026-11-10T12:30:00Z',
    timezone: 'Europe/Rome',
  });
  const seed = async (ai = false) => {
    const id = await user();
    let time = clock();
    const s = setup(() => time);
    const state = await configure(s, id, ai);
    time = new Date('2026-11-10T12:30:00Z');
    const a = observation();
    await s.upload(id, { epoch: state.epoch, visits: [a] });
    return {
      id,
      s,
      a,
      state,
      setTime: (value: Date) => {
        time = value;
      },
    };
  };
  const stored = async (id: string) => {
    const row = (
      await owner.query<{ revision: number; envelope: unknown }>(
        'SELECT revision,envelope FROM habits_state WHERE user_id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('missing fixture state');
    const context = {
      userId: id,
      resourceKind: 'habits-state',
      resourceId: id,
      resourceVersion: row.revision,
    };
    return {
      context,
      state: HabitState.parse(JSON.parse(cipher.decrypt(context, row.envelope).toString('utf8'))),
    };
  };
  const editStored = async (id: string, edit: (s: HabitState) => void) => {
    const { context, state } = await stored(id);
    edit(state);
    const revision = context.resourceVersion + 1;
    const envelope = cipher.encrypt(
      { ...context, resourceVersion: revision },
      Buffer.from(JSON.stringify(HabitState.parse(state))),
    );
    await owner.query('UPDATE habits_state SET revision=$2,envelope=$3 WHERE user_id=$1', [
      id,
      revision,
      JSON.stringify(envelope),
    ]);
  };
  beforeAll(async () => {
    owner = createPool({ connectionString: url as string });
    app = createPool({
      connectionString: 'postgres://ernie_app:synthetic-habits-app@127.0.0.1:62204/ernie',
      max: 8,
    });
    const r = await app.query(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await Promise.all([owner.end(), app.end()]);
    cipher.destroy();
  });
  it('defaults fail closed, skill off refuses collection and missing key refuses reads', async () => {
    const id = await user(false),
      s = setup();
    expect(await s.get(id)).toMatchObject({ collecting: false, aiAllowed: false, visits: [] });
    await expect(configure(s, id)).rejects.toMatchObject({ code: 'habits_disabled' });
    const unavailable = createHabitsService({ pool: app, cipher: null, places: async () => [] });
    await expect(unavailable.get(id)).rejects.toMatchObject({ code: 'habits_unavailable' });
  });
  it('encrypts all mobility data and isolates user reads including raw SQL', async () => {
    const { id, s, a } = await seed();
    const b = await user();
    expect((await s.get(id)).visits).toHaveLength(1);
    expect((await s.get(b)).visits).toEqual([]);
    const raw = await owner.query(
      'SELECT row_to_json(h)::text raw FROM habits_state h WHERE user_id=$1',
      [id],
    );
    expect(raw.rows[0].raw).not.toContain(a.arrival);
    expect(raw.rows[0].raw).not.toContain('latitude');
    expect(
      await withUser(
        app,
        b,
        async (c) => (await c.query('SELECT * FROM habits_state WHERE user_id=$1', [id])).rowCount,
      ),
    ).toBe(0);
  });
  it('rejects stale config and epoch after pause, retains manual history', async () => {
    const { id, s, state, a } = await seed();
    await expect(
      s.configure(id, {
        expectedRevision: 0,
        collecting: false,
        aiAllowed: false,
        retentionDays: 30,
        policyVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'habits_changed' });
    await s.pause(id);
    await expect(s.upload(id, { epoch: state.epoch, visits: [a] })).rejects.toMatchObject({
      code: 'habits_paused',
    });
    expect((await s.get(id)).visits).toHaveLength(1);
  });
  it('skill revocation gates uploads and AI even before the pause callback', async () => {
    const { id, s, state, a } = await seed(true);
    await owner.query('UPDATE users SET settings=$2 WHERE id=$1', [
      id,
      { skills: { abitudini: false } },
    ]);
    await expect(s.upload(id, { epoch: state.epoch, visits: [a] })).rejects.toMatchObject({
      code: 'habits_disabled',
    });
    expect(await s.context(id, 'Le mie abitudini di lavoro')).toBeNull();
  });
  it('forgets canonical observation and aliases from other devices without resurrection', async () => {
    const { id, s, state, a } = await seed();
    const b = { ...a, id: randomUUID() };
    await s.upload(id, { epoch: state.epoch, visits: [b] });
    await s.act(id, { action: 'forget_visit', id: a.id });
    await s.upload(id, { epoch: state.epoch, visits: [a, b] });
    expect((await s.get(id)).visits).toHaveLength(0);
  });
  it('suppresses offline unseen IDs across concurrent deletion and retries, preserving later visits', async () => {
    const { id, s, state, a, setTime } = await seed();
    setTime(new Date('2026-11-10T14:30:00Z'));
    const later = {
      ...observation(),
      arrival: '2026-11-10T14:01:00Z',
      departure: '2026-11-10T14:20:00Z',
      observedAt: '2026-11-10T14:30:00Z',
    };
    await s.upload(id, { epoch: state.epoch, visits: [later] });
    await Promise.all([
      s.act(id, { action: 'forget_visit', id: a.id }),
      s.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] }),
    ]);
    await Promise.all([
      s.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] }),
      s.upload(id, {
        epoch: state.epoch,
        visits: [
          {
            ...a,
            id: randomUUID(),
            arrival: '2026-11-10T12:01:02Z',
            latitude: a.latitude + 0.00002,
            longitude: a.longitude + 0.00002,
          },
        ],
      }),
    ]);
    const result = await s.get(id);
    expect(result.visits.map((v) => v.id)).toEqual([later.id]);
    expect(result).not.toHaveProperty('observationKey');
    expect(result).not.toHaveProperty('forgottenObservations');
    const persisted = (await stored(id)).state;
    expect(persisted.forgottenObservations).toEqual([
      {
        arrival: expect.stringMatching(/^[a-f0-9]{64}$/),
        departure: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: '2027-02-08T14:30:00.000Z',
      },
    ]);
    const raw = await owner.query(
      'SELECT row_to_json(h)::text raw FROM habits_state h WHERE user_id=$1',
      [id],
    );
    expect(raw.rows[0].raw).not.toContain(persisted.observationKey);
    expect(raw.rows[0].raw).not.toContain('forgottenObservations');
  });
  it('rolls back a whole upload when valid partial inputs would create an invalid merged visit', async () => {
    const { id, s, state, a } = await seed();
    const partial = { ...a, id: randomUUID(), arrival: '2026-11-10T12:22:00Z', departure: null };
    await s.upload(id, { epoch: state.epoch, visits: [partial] });
    const before = await stored(id);
    await expect(
      s.upload(id, {
        epoch: state.epoch,
        visits: [
          { ...a, id: randomUUID(), latitude: 46 },
          {
            ...a,
            id: randomUUID(),
            arrival: '2026-11-10T12:21:00Z',
            departure: '2026-11-10T12:21:30Z',
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_visits' });
    expect(await stored(id)).toEqual(before);
  });
  it('reports alias capacity explicitly without poisoning state or blocking deletion', async () => {
    const { id, s, state, a } = await seed();
    await editStored(id, (data) => {
      data.visitAliases[a.id] = Array.from({ length: 20 }, () => randomUUID());
    });
    const before = await stored(id);
    await expect(
      s.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'habits_capacity' });
    expect(await stored(id)).toEqual(before);
    await s.act(id, { action: 'forget_visit', id: a.id });
    await s.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] });
    expect((await s.get(id)).visits).toHaveLength(0);
  });
  it('prunes expired suppression records before checking deletion capacity', async () => {
    const { id, s, a } = await seed();
    await editStored(id, (data) => {
      const expiresAt = '2026-11-10T12:15:00Z';
      data.ignoredVisitIds = Array.from({ length: 5000 }, () => ({
        id: randomUUID(),
        expiresAt,
      }));
      const fingerprint = forgottenObservation(data, a, expiresAt);
      data.forgottenObservations = Array.from({ length: 5000 }, () => ({ ...fingerprint }));
    });
    await s.act(id, { action: 'forget_visit', id: a.id });
    const persisted = (await stored(id)).state;
    expect(persisted.visits).toEqual([]);
    expect(persisted.ignoredVisitIds).toHaveLength(1);
    expect(persisted.forgottenObservations).toHaveLength(1);
  });
  it('linked alias refinement stays one visit and deletion removes every linked ID', async () => {
    const { id, s, state, a } = await seed();
    const b = { ...a, id: randomUUID() };
    await s.upload(id, { epoch: state.epoch, visits: [b] });
    await s.upload(id, {
      epoch: state.epoch,
      visits: [{ ...b, latitude: b.latitude + 0.0008, accuracyM: 5 }],
    });
    expect((await s.get(id)).visits).toHaveLength(1);
    await s.act(id, { action: 'forget_visit', id: a.id });
    expect((await s.get(id)).visits).toHaveLength(0);
  });
  it('increasing retention cannot restore observations already expired under the old policy', async () => {
    const { id, s, a, setTime } = await seed();
    let state = await s.get(id);
    await s.configure(id, {
      expectedRevision: state.revision,
      collecting: true,
      aiAllowed: false,
      retentionDays: 7,
      policyVersion: 1,
    });
    setTime(new Date('2026-11-20T12:00:00Z'));
    state = await s.get(id);
    expect(state.visits).toHaveLength(0);
    await s.configure(id, {
      expectedRevision: state.revision,
      collecting: true,
      aiAllowed: false,
      retentionDays: 90,
      policyVersion: 1,
    });
    await Promise.all([
      s.upload(id, { epoch: state.epoch, visits: [a] }),
      s.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] }),
    ]);
    expect((await s.get(id)).visits).toHaveLength(0);
    expect((await stored(id)).state.visits).toHaveLength(0);
  });
  it('exclusion drops stored and future visits and clear rotates epoch', async () => {
    const { id, s, state, a } = await seed();
    const p = (await s.get(id)).places[0];
    if (!p) throw new Error('missing fixture place');
    await s.act(id, { action: 'exclude_place', id: p.id });
    await s.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] });
    expect((await s.get(id)).visits).toHaveLength(0);
    await s.act(id, { action: 'clear' });
    expect((await s.get(id)).places).toHaveLength(0);
    await expect(s.upload(id, { epoch: state.epoch, visits: [a] })).rejects.toMatchObject({
      code: 'habits_paused',
    });
  });
  it('does not repopulate excluded place descriptions from geographic profile suggestions', async () => {
    const { id, s, state, a } = await seed();
    const p = (await s.get(id)).places[0];
    if (!p) throw new Error('missing fixture place');
    await s.act(id, { action: 'exclude_place', id: p.id });
    const linked = createHabitsService({
      pool: app,
      cipher,
      now: () => new Date(a.observedAt),
      places: async () => [{ id: 'profile-place', label: 'Ufficio', lat: 45, lng: 12 }],
    });
    await linked.upload(id, { epoch: state.epoch, visits: [{ ...a, id: randomUUID() }] });
    expect((await linked.get(id)).places).toEqual([
      expect.objectContaining({
        id: p.id,
        excluded: true,
        label: 'Luogo escluso',
        purpose: '',
        linkedPlaceId: null,
        confirmedAt: null,
      }),
    ]);
  });
  it('one question per stable day; later works on next day and expired evidence cannot ask', async () => {
    const { id, s, setTime } = await seed();
    const q = await s.question(id, 'Pacific/Kiritimati');
    expect(q).not.toBeNull();
    await s.act(id, { action: 'later', id: q?.placeId });
    expect(await s.question(id, 'Pacific/Honolulu')).toBeNull();
    setTime(new Date('2026-11-11T13:00:00Z'));
    expect(await s.question(id, 'Europe/Rome')).not.toBeNull();
    setTime(new Date('2026-12-20T13:00:00Z'));
    expect(await s.question(id, 'Europe/Rome')).toBeNull();
    expect((await s.get(id)).places).toHaveLength(0);
  });
  it('clear and re-enable cannot reset the daily allowance, including concurrent questions', async () => {
    const { id, s, setTime } = await seed();
    expect(await s.question(id, 'Europe/Rome')).not.toBeNull();
    await s.act(id, { action: 'clear' });
    const state = await configure(s, id);
    setTime(new Date('2026-11-10T14:30:00Z'));
    await s.upload(id, {
      epoch: state.epoch,
      visits: [
        {
          ...observation(),
          arrival: '2026-11-10T14:01:00Z',
          departure: '2026-11-10T14:20:00Z',
          observedAt: '2026-11-10T14:30:00Z',
        },
      ],
    });
    expect(
      await Promise.all([s.question(id, 'Pacific/Kiritimati'), s.question(id, 'Pacific/Honolulu')]),
    ).toEqual([null, null]);
    await editStored(id, (data) => {
      data.lastQuestionDay = null;
    });
    expect(await s.question(id, 'Europe/Rome')).toBeNull();
    const sent = await owner.query(
      "SELECT count(*)::int n FROM proactive_messages WHERE user_id=$1 AND kind='habit_learning' AND status='sent'",
      [id],
    );
    expect(sent.rows[0].n).toBe(1);
  });
  it('does not return a question when the daily delivery key was already claimed', async () => {
    const { id, s } = await seed();
    await withUser(app, id, async (c) => {
      await c.query(
        "INSERT INTO proactive_messages(user_id,kind,dedupe_key,title,body,evidence,status) VALUES($1,'habit_learning','habit_learning:2026-11-10','Fixture','Fixture',$2,'pending')",
        [id, JSON.stringify({ source: 'user', refs: [] })],
      );
    });
    expect(await s.question(id, 'Europe/Rome')).toBeNull();
    const persisted = (await stored(id)).state;
    expect(persisted.lastQuestionDay).toBeNull();
    expect(persisted.places[0]?.askedAt).toBeNull();
  });
  it('AI disclosure requires consent and relevance, excludes raw coordinates and unconfirmed places', async () => {
    const { id, s } = await seed(true);
    expect(await s.context(id, 'Quali abitudini ho in ufficio?')).toBeNull();
    const p = (await s.get(id)).places[0];
    if (!p) throw new Error('missing fixture place');
    await s.updatePlace(id, p.id, {
      label: 'Ufficio',
      purpose: 'Lavoro',
      frequency: 'habitual',
      linkedPlaceId: null,
    });
    const block = await s.context(id, 'Quali abitudini ho in ufficio?');
    expect(block).toContain('Ufficio');
    expect(block).not.toContain('latitude');
    expect(await s.context(id, 'Scrivi una poesia')).toBeNull();
    const state = await s.get(id);
    await s.configure(id, {
      expectedRevision: state.revision,
      collecting: true,
      aiAllowed: false,
      retentionDays: 30,
      policyVersion: 1,
    });
    expect(await s.context(id, 'Quali abitudini ho in ufficio?')).toBeNull();
  });
  it('maintenance prunes persisted evidence even for paused accounts', async () => {
    const { id, s, setTime } = await seed();
    await s.pause(id);
    setTime(new Date('2027-01-01T12:00:00Z'));
    await s.maintainAll();
    expect((await s.get(id)).visits).toHaveLength(0);
    expect((await stored(id)).state.visits).toHaveLength(0);
  });
  it('isolates a corrupt archive during maintenance and still reports the failed sweep', async () => {
    const [broken, healthy] = [await seed(), await seed()].sort((a, b) => a.id.localeCompare(b.id));
    if (!broken || !healthy) throw new Error('missing fixture accounts');
    await owner.query("UPDATE habits_state SET envelope='{}'::jsonb WHERE user_id=$1", [broken.id]);
    healthy.setTime(new Date('2027-01-01T12:00:00Z'));
    try {
      await expect(healthy.s.maintainAll()).rejects.toMatchObject({
        statusCode: 503,
        code: 'habits_maintenance_failed',
      });
      expect((await stored(healthy.id)).state.visits).toEqual([]);
    } finally {
      await owner.query('DELETE FROM habits_state WHERE user_id=$1', [broken.id]);
    }
  });
  it('HTTP authenticates, validates, isolates and marks private responses no-store', async () => {
    const { id, s } = await seed();
    const api = Fastify();
    await api.register(habitsRoutes, {
      service: s,
      allowedOrigins: [],
      authenticator: {
        authenticate: async (token) =>
          token === 'synthetic'
            ? {
                userId: id,
                apiKeyId: randomUUID(),
                scopes: ['chat'],
                role: 'owner',
                companionName: 'Fixture',
                settings: {},
              }
            : null,
      },
    });
    try {
      expect((await api.inject({ url: '/v1/habits' })).statusCode).toBe(401);
      const r = await api.inject({
        url: '/v1/habits',
        headers: { authorization: 'Bearer synthetic' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const bad = await api.inject({
        url: '/v1/habits/visits',
        method: 'POST',
        headers: { authorization: 'Bearer synthetic' },
        payload: { secret: 'must-not-echo' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('must-not-echo');
    } finally {
      await api.close();
    }
  });
});
