import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { TodoItem, TodoSlot } from '@ernie/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTodoRepository, type TodoRepository, type TodoSaveInput } from './todo.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
describe.skipIf(!OWNER_URL || !APP_PASSWORD)(
  'Todo PostgreSQL ownership, history and atomic scheduling',
  () => {
    let owner: Pool, app: Pool, repo: TodoRepository;
    const a = randomUUID(),
      b = randomUUID();
    const changed = vi.fn(async () => {});
    const input = (extra: Partial<TodoSaveInput> = {}): TodoSaveInput => ({
      id: randomUUID(),
      name: 'Lista',
      mode: 'simple',
      day: null,
      timezone: 'Europe/Rome',
      items: [TodoItem.parse({ id: randomUUID(), title: 'Attività' })],
      ...extra,
    });
    beforeAll(async () => {
      owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
      const url = new URL(OWNER_URL as string);
      url.username = 'ernie_app';
      url.password = APP_PASSWORD as string;
      app = createPool({ connectionString: url.toString(), max: 4 });
      await owner.query("INSERT INTO users(id,display_name) VALUES($1,'Todo A'),($2,'Todo B')", [
        a,
        b,
      ]);
      repo = createTodoRepository(app, { onChanged: changed });
    });
    afterAll(async () => {
      await owner?.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[a, b]]);
      await app?.end();
      await owner?.end();
    });
    it('creates and updates idempotently, rejects stale revisions, preserves immutable history', async () => {
      const draft = input();
      const first = await repo.save(a, draft);
      expect(first.revision).toBe(1);
      expect(await repo.save(a, draft)).toEqual(first);
      const upper = JSON.parse(
        JSON.stringify(draft).replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, (uuid: string) =>
          uuid.toUpperCase(),
        ),
      );
      expect(await repo.save(a, upper)).toEqual(first);
      const update = { ...draft, revision: 1, name: 'Nuovo nome' };
      const second = await repo.save(a, update);
      expect(second.revision).toBe(2);
      expect(await repo.save(a, update)).toEqual(second);
      await expect(repo.save(a, { ...update, name: 'Scrittura obsoleta' })).rejects.toMatchObject({
        code: 'revision_conflict',
      });
      expect(await repo.get(a, first.id)).toEqual(second);
      expect(await repo.history(a, first.id)).toEqual([first, second]);
      await expect(
        withUser(app, a, (c) =>
          c.query("UPDATE todo_list_revisions SET snapshot='{}' WHERE user_id=$1 AND list_id=$2", [
            a,
            first.id,
          ]),
        ),
      ).rejects.toThrow();
    });
    it('isolates identical client IDs between users and enforces RLS against owner-less queries', async () => {
      const draft = input();
      const own = await repo.save(a, draft);
      expect(await repo.get(b, own.id)).toBeNull();
      expect(await repo.history(b, own.id)).toEqual([]);
      const theirs = await repo.save(b, { ...draft, name: 'Lista B' });
      expect(theirs.name).toBe('Lista B');
      expect((await repo.get(a, own.id))?.name).toBe('Lista');
      const read = await withUser(app, b, (c) => c.query('SELECT user_id FROM todo_lists'));
      expect(read.rows.every((r: { user_id: string }) => r.user_id === b)).toBe(true);
      await expect(
        withUser(app, b, (c) =>
          c.query('UPDATE todo_lists SET user_id=$1 WHERE id=$2', [a, theirs.id]),
        ),
      ).rejects.toThrow();
    });
    it('serializes simultaneous creates for one day and retains old data on overlap', async () => {
      const scheduled = input({ mode: 'scheduled', day: '2026-10-19', items: [] });
      const attempts = await Promise.allSettled([
        repo.save(a, scheduled),
        repo.save(a, { ...scheduled, id: randomUUID() }),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const saved = (await repo.list(a, { day: '2026-10-19' }))[0];
      if (!saved) throw new Error('missing scheduled list');
      const slot = TodoSlot.parse({
        id: randomUUID(),
        startAt: '2026-10-19T15:00:00+02:00',
        endAt: '2026-10-19T16:00:00+02:00',
      });
      await expect(
        repo.save(a, {
          ...scheduled,
          id: saved.id,
          revision: saved.revision,
          items: [
            TodoItem.parse({ id: randomUUID(), title: 'A', slots: [slot] }),
            TodoItem.parse({
              id: randomUUID(),
              title: 'B',
              slots: [{ ...slot, id: randomUUID() }],
            }),
          ],
        }),
      ).rejects.toMatchObject({ code: 'schedule_conflict' });
      expect(await repo.get(a, saved.id)).toEqual(saved);
    });
    it('keeps committed data recoverable after hook failure; identical resave retries reconciliation', async () => {
      const callback = vi
        .fn()
        .mockRejectedValueOnce(new Error('reminder temporarily unavailable'))
        .mockResolvedValue(undefined);
      const hooked = createTodoRepository(app, { onChanged: callback });
      const draft = input();
      await expect(hooked.save(a, draft)).rejects.toThrow('temporarily unavailable');
      const saved = await hooked.get(a, draft.id);
      expect(saved?.revision).toBe(1);
      expect(await hooked.save(a, draft)).toEqual(saved);
      expect(callback).toHaveBeenCalledTimes(2);
      const pending = await app.query(
        'SELECT * FROM todo_pending_reminders() WHERE user_id=$1 AND id=$2',
        [a, draft.id],
      );
      expect(pending.rows).toHaveLength(1);
    });
    it('converts to a simple list without losing checked and cancelled children or scheduled history', async () => {
      const draft = input({
        mode: 'scheduled',
        day: '2026-10-20',
        items: [
          TodoItem.parse({
            id: randomUUID(),
            title: 'Conclusa',
            status: 'done',
            slots: [
              TodoSlot.parse({
                id: randomUUID(),
                startAt: '2026-10-20T15:00:00+02:00',
                endAt: '2026-10-20T16:00:00+02:00',
                reminderMinutes: 25,
              }),
            ],
          }),
          TodoItem.parse({ id: randomUUID(), title: 'Annullata', status: 'cancelled' }),
        ],
      });
      const first = await repo.save(a, draft);
      const simple = await repo.save(a, { ...draft, revision: 1, mode: 'simple' });
      expect(simple.items.map((i) => i.status)).toEqual(['done', 'cancelled']);
      expect(simple.items.every((i) => i.slots.length === 0)).toBe(true);
      expect((await repo.history(a, first.id))[0]?.items[0]?.slots).toHaveLength(1);
    });
  },
);
