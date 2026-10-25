import { randomUUID } from 'node:crypto';
import type { AutomationQueue } from '@ernie/automations';
import { createPool, type Pool, withUser } from '@ernie/db';
import { TodoItem, TodoList, TodoSlot } from '@ernie/protocol';
import { createTodoRepository } from '@ernie/tools';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTodoReminderSync, desiredTodoReminders } from './todo-reminders.js';

const makeList = () => {
  const group = TodoItem.parse({ id: randomUUID(), kind: 'group', title: 'Cloe' });
  const task = (title: string, hour: string) =>
    TodoItem.parse({
      id: randomUUID(),
      parentId: group.id,
      title,
      slots: [
        TodoSlot.parse({
          id: randomUUID(),
          startAt: `2100-10-19T${hour}:00:00+02:00`,
          endAt: `2100-10-19T${hour}:15:00+02:00`,
          reminderMinutes: 30,
        }),
      ],
    });
  return TodoList.parse({
    id: randomUUID(),
    name: 'Giornata',
    mode: 'scheduled',
    day: '2100-10-19',
    timezone: 'Europe/Rome',
    revision: 1,
    updatedAt: new Date().toISOString(),
    items: [group, task('Accompagnare', '15'), task('Riprendere', '18')],
  });
};
describe('Todo reminder derivation', () => {
  it('keeps drop-off and pickup independent, with separate lead times', () => {
    const list = makeList();
    const planned = desiredTodoReminders(list);
    expect(planned).toHaveLength(2);
    expect(planned.map((r) => r.at)).toEqual([
      '2100-10-19T12:30:00.000Z',
      '2100-10-19T15:30:00.000Z',
    ]);
    expect(planned[0]?.title).toBe('Cloe: Accompagnare');
    list.items[1]!.status = 'done';
    expect(desiredTodoReminders(list).map((r) => r.taskId)).toEqual([list.items[2]!.id]);
  });
  it('conversion, cancelled tasks and explicit no-reminder produce no notifications', () => {
    const list = makeList();
    expect(desiredTodoReminders({ ...list, mode: 'simple' })).toEqual([]);
    list.items[1]!.status = 'cancelled';
    list.items[2]!.slots[0]!.reminderMinutes = null;
    expect(desiredTodoReminders(list)).toEqual([]);
  });
});

const ownerURL = process.env.MIGRATIONS_DATABASE_URL;
const appURL = process.env.DATABASE_URL;
describe.skipIf(!ownerURL || !appURL)('Todo persisted reminder reconciliation', () => {
  let owner: Pool, app: Pool;
  const user = randomUUID();
  const queue = {
    getJob: vi.fn(async () => null),
    add: vi.fn(async () => ({})),
  } as unknown as AutomationQueue;
  beforeAll(async () => {
    owner = createPool({ connectionString: ownerURL! });
    app = createPool({ connectionString: appURL! });
    await owner.query("INSERT INTO users(id,display_name) VALUES($1,'Todo reminder test')", [user]);
  });
  afterAll(async () => {
    await owner?.query('DELETE FROM users WHERE id=$1', [user]);
    await app?.end();
    await owner?.end();
  });
  const active = async (id: string) =>
    withUser(app, user, (c) =>
      c.query<{ id: string; meta: Record<string, string>; trigger: { at: string } }>(
        "SELECT id,meta,trigger FROM automations WHERE user_id=$1 AND enabled AND meta->>'todoListId'=$2 ORDER BY trigger->>'at'",
        [user, id],
      ),
    );
  const input = (list: TodoList, creating = false) => {
    const { updatedAt: _, revision, ...rest } = list;
    return { ...rest, ...(creating ? {} : { revision }) };
  };
  it('recovers a commit without its hook; retries preserve alarm IDs; moves replace only affected alarms; conversion cancels all', async () => {
    const sync = createTodoReminderSync({ pool: app, queue });
    const repo = createTodoRepository(app);
    const list = await repo.save(user, input(makeList(), true));
    expect((await active(list.id)).rows).toEqual([]);
    await sync.drain();
    const first = (await active(list.id)).rows;
    expect(first).toHaveLength(2);
    await Promise.all([sync.sync(user, list.id), sync.drain()]);
    expect((await active(list.id)).rows.map((r) => r.id)).toEqual(first.map((r) => r.id));
    const changed = structuredClone(list);
    changed.items[1]!.slots[0]!.startAt = '2100-10-19T16:00:00+02:00';
    changed.items[1]!.slots[0]!.endAt = '2100-10-19T16:15:00+02:00';
    const moved = await repo.save(user, input(changed));
    await sync.sync(user, list.id);
    const second = (await active(list.id)).rows;
    expect(second).toHaveLength(2);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    expect(second[1]!.id).toBe(first[1]!.id);
    expect(second[0]!.meta.eventAt).toBe('2100-10-19T14:00:00.000Z');
    expect(second[0]!.trigger.at).toBe('2100-10-19T13:30:00.000Z');
    const done = structuredClone(moved);
    done.items[1]!.status = 'done';
    const completed = await repo.save(user, input(done));
    await sync.sync(user, list.id);
    expect((await active(list.id)).rows.map((r) => r.id)).toEqual([second[1]!.id]);
    const simple = await repo.save(user, input({ ...completed, mode: 'simple', day: null }));
    await sync.sync(user, list.id);
    expect((await active(list.id)).rows).toEqual([]);
    expect(simple.items[1]!.status).toBe('done');
    expect(await repo.history(user, list.id)).toHaveLength(4);
    expect(
      await withUser(
        app,
        user,
        async (c) =>
          (
            await c.query(
              'SELECT reminder_revision,revision FROM todo_lists WHERE user_id=$1 AND id=$2',
              [user, list.id],
            )
          ).rows[0],
      ),
    ).toEqual({ reminder_revision: 4, revision: 4 });
  });
  it('does not invent future dates or fire a newly created past reminder', async () => {
    const list = makeList();
    list.day = '2000-10-19';
    list.items = list.items.map((i) => ({
      ...i,
      slots: i.slots.map((s) => ({
        ...s,
        startAt: s.startAt.replace('2100', '2000'),
        endAt: s.endAt.replace('2100', '2000'),
      })),
    }));
    const repo = createTodoRepository(app);
    const saved = await repo.save(user, input(list, true));
    await createTodoReminderSync({ pool: app, queue }).sync(user, saved.id);
    expect((await active(saved.id)).rows).toEqual([]);
    expect((await repo.get(user, saved.id))?.day).toBe('2000-10-19');
  });
  it('a list that always fails waits with backoff and does not hold the recovery scan', async () => {
    const repo = createTodoRepository(app);
    const broken = await repo.save(user, input(makeList(), true));
    // Dati non più leggibili dal modello attuale: la riconciliazione fallisce a ogni passata.
    await owner.query(
      `UPDATE todo_lists SET items='[{"bad":true}]'::jsonb, revision=revision+1 WHERE user_id=$1 AND id=$2`,
      [user, broken.id],
    );
    let clock = Date.now();
    const failures: string[] = [];
    const sync = createTodoReminderSync({
      pool: app,
      queue,
      now: () => clock,
      onError: () => failures.push('x'),
    });
    const pending = async () =>
      (
        await app.query<{ id: string }>('SELECT id FROM todo_pending_reminders($1::uuid[])', [
          [broken.id],
        ])
      ).rows.map((r) => r.id);
    await sync.drain();
    expect(failures).toHaveLength(1);
    await sync.drain();
    expect(failures).toHaveLength(1);
    expect(await pending()).not.toContain(broken.id);
    clock += 61_000;
    await sync.drain();
    expect(failures).toHaveLength(2);
    // Seconda attesa più lunga: due minuti.
    clock += 61_000;
    await sync.drain();
    expect(failures).toHaveLength(2);
    await owner.query('DELETE FROM todo_lists WHERE user_id=$1 AND id=$2', [user, broken.id]);
  });
});
