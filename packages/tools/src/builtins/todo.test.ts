import { randomUUID } from 'node:crypto';
import { ContentBlock, TodoItem, TodoList, TodoSlot } from '@ernie/protocol';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  checkModelOffsets,
  createTodoTools,
  type TodoRepository,
  type TodoSaveInput,
  TodoValidationError,
  validateTodoSnapshot,
} from './todo.js';

const day = '2026-10-19';
const slot = (start: string, end: string) =>
  TodoSlot.parse({
    id: randomUUID(),
    startAt: `${day}T${start}:00+02:00`,
    endAt: `${day}T${end}:00+02:00`,
    reminderMinutes: 25,
  });
const item = (title: string, extra: Partial<TodoItem> = {}) =>
  TodoItem.parse({ id: randomUUID(), title, ...extra });
const list = (items: TodoItem[], extra: Partial<TodoSaveInput> = {}): TodoSaveInput => ({
  id: randomUUID(),
  name: 'Oggi',
  mode: 'scheduled',
  day,
  timezone: 'Europe/Rome',
  items,
  ...extra,
});
function code(input: TodoSaveInput) {
  try {
    validateTodoSnapshot(input);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(TodoValidationError);
    return (e as TodoValidationError).code;
  }
}
describe('Todo canonical hierarchy and schedule', () => {
  it('keeps Cloe/Pizza with two children each, unoccupied pizza wait, and split Stimo time', () => {
    const cloe = item('Cloe', { kind: 'group' }),
      pizza = item('Pizza', { kind: 'group' });
    const dough = item('Impasto', { parentId: pizza.id, slots: [slot('12:00', '12:20')] });
    const bake = item('Cottura serale', {
      parentId: pizza.id,
      dependsOn: [{ taskId: dough.id, lagMinutes: 180 }],
      slots: [slot('19:30', '20:00')],
    });
    const drop = item('Accompagnare', { parentId: cloe.id, slots: [slot('14:50', '15:00')] });
    const pick = item('Riprendere', { parentId: cloe.id, slots: [slot('17:50', '18:00')] });
    const stimo = item('Stimo', {
      minimumMinutes: 60,
      splittable: true,
      slots: [slot('15:10', '15:40'), slot('16:10', '16:40')],
    });
    const result = validateTodoSnapshot(list([cloe, pizza, dough, bake, drop, pick, stimo]));
    expect(result.items.filter((i) => i.parentId === cloe.id)).toHaveLength(2);
    expect(result.items.filter((i) => i.parentId === pizza.id)).toHaveLength(2);
    expect(result.items.find((i) => i.id === pick.id)?.dependsOn).toEqual([]);
    expect(result.items.find((i) => i.id === stimo.id)?.slots).toHaveLength(2);
  });
  it('conversion clears all slots/reminders and preserves IDs, dependencies, completion and siblings', () => {
    const group = item('Cloe', { kind: 'group' });
    const done = item('Accompagnare', {
      parentId: group.id,
      status: 'done',
      slots: [slot('14:50', '15:00')],
    });
    const pending = item('Riprendere', { parentId: group.id, slots: [slot('17:50', '18:00')] });
    const input = list([group, done, pending], { mode: 'simple' });
    const result = validateTodoSnapshot(input);
    expect(result.day).toBeNull();
    expect(result.items.map((i) => [i.id, i.parentId, i.status, i.slots])).toEqual([
      [group.id, null, 'pending', []],
      [done.id, group.id, 'done', []],
      [pending.id, group.id, 'pending', []],
    ]);
    expect(input.items[1]?.slots).toHaveLength(1);
  });
  it('rejects malformed hierarchy and dependency cycles, not just task extraction', () => {
    const a = item('A'),
      b = item('B');
    expect(code(list([{ ...a, parentId: b.id }, b]))).toBe('invalid_parent');
    expect(
      code(
        list([
          { ...a, kind: 'group', parentId: b.id },
          { ...b, kind: 'group', parentId: a.id },
        ]),
      ),
    ).toBe('parent_cycle');
    expect(
      code(
        list([
          { ...a, dependsOn: [{ taskId: b.id, lagMinutes: 0 }] },
          { ...b, dependsOn: [{ taskId: a.id, lagMinutes: 0 }] },
        ]),
      ),
    ).toBe('dependency_cycle');
    expect(code(list([{ ...a, dependsOn: [{ taskId: randomUUID(), lagMinutes: 0 }] }]))).toBe(
      'invalid_dependency',
    );
    expect(code(list([a, a]))).toBe('duplicate_item');
    expect(code(list([item('Gruppo', { kind: 'group', status: 'done' })]))).toBe('group_status');
    expect(code(list([item('Gruppo', { kind: 'group', status: 'cancelled' })]))).toBe(
      'group_status',
    );
  });
  it('normalizes iOS uppercase UUIDs across hierarchy, dependencies and slots', () => {
    const group = item('Pizza', { kind: 'group' });
    const dough = item('Impasto', { parentId: group.id });
    const cook = item('Cottura', {
      parentId: group.id,
      dependsOn: [{ taskId: dough.id, lagMinutes: 0 }],
    });
    const input = list([group, dough, cook], { mode: 'simple' });
    const upper = JSON.parse(
      JSON.stringify(input).replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, (uuid: string) =>
        uuid.toUpperCase(),
      ),
    );
    expect(validateTodoSnapshot(upper)).toEqual(validateTodoSnapshot(input));
  });
  it('enforces cumulative minimum and explicit split permission', () => {
    expect(
      code(list([item('Stimo', { minimumMinutes: 60, slots: [slot('15:00', '15:30')] })])),
    ).toBe('minimum_duration');
    expect(
      code(list([item('Stimo', { slots: [slot('15:00', '15:30'), slot('16:00', '16:30')] })])),
    ).toBe('not_splittable');
    expect(
      code(
        list([
          item('Stimo', {
            minimumMinutes: 60,
            splittable: true,
            slots: [slot('15:00', '15:30'), slot('16:00', '16:30')],
          }),
        ]),
      ),
    ).toBeNull();
  });
  it('reports overlap with stable task/slot references; cancellation frees its interval', () => {
    const a = item('Palestra', { slots: [slot('15:00', '16:00')] });
    const b = item('Spesa', { slots: [slot('15:30', '16:10')] });
    try {
      validateTodoSnapshot(list([a, b]));
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'schedule_conflict',
        statusCode: 409,
        details: [{ itemIds: [a.id, b.id] }],
      });
    }
    expect(code(list([a, { ...b, status: 'cancelled' }]))).toBeNull();
    expect(code(list([a, { ...b, slots: [slot('16:00', '16:40')] }]))).toBeNull();
  });
  it('checks overlap with another same-day list', () => {
    const other = TodoList.parse({
      ...list([item('Visita', { slots: [slot('11:00', '12:00')] })]),
      revision: 1,
      updatedAt: new Date().toISOString(),
    });
    expect(() =>
      validateTodoSnapshot(list([item('Spesa', { slots: [slot('11:30', '12:10')] })]), [other]),
    ).toThrow(TodoValidationError);
  });
  it('enforces dependency lag without adding waiting slots', () => {
    const a = item('Impasto', { slots: [slot('12:00', '12:20')] });
    const b = item('Cottura', {
      dependsOn: [{ taskId: a.id, lagMinutes: 180 }],
      slots: [slot('15:00', '15:30')],
    });
    expect(code(list([a, b]))).toBe('dependency_lag');
    expect(code(list([a, { ...b, slots: [slot('15:20', '15:50')] }]))).toBeNull();
    expect(code(list([{ ...a, slots: [] }, b]))).toBe('dependency_unscheduled');
  });
  it('checks real calendar dates, IANA zone and local day, never rolls overdue dates forward', () => {
    expect(code(list([], { day: '2026-02-30' }))).toBe('invalid_day');
    expect(code(list([], { timezone: 'Invented/Zone' }))).toBe('invalid_timezone');
    expect(code(list([], { day: null }))).toBe('day_required');
    expect(code(list([item('Fine prima dell’inizio', { slots: [slot('16:00', '15:00')] })]))).toBe(
      'invalid_interval',
    );
    const utc = TodoSlot.parse({
      id: randomUUID(),
      startAt: '2026-10-18T23:00:00Z',
      endAt: '2026-10-18T23:30:00Z',
    });
    expect(code(list([item('Ora locale', { slots: [utc] })]))).toBeNull();
    expect(code(list([item('Giorno precedente', { slots: [utc] })], { timezone: 'UTC' }))).toBe(
      'day_mismatch',
    );
    expect(validateTodoSnapshot(list([], { day: '2020-01-01' })).day).toBe('2020-01-01');
  });
  it('orari del modello: rifiuta la confusione del cambio dell’ora, non gli altri casi', () => {
    const at = (start: string, end: string) =>
      TodoSlot.parse({ id: randomUUID(), startAt: start, endAt: end });
    const check = (input: TodoSaveInput) => {
      try {
        checkModelOffsets(input);
        return null;
      } catch (e) {
        return e instanceof TodoValidationError ? e.code : String(e);
      }
    };
    const one = (start: string, end: string, theDay = '2026-10-25') =>
      list([item('Palestra', { slots: [at(start, end)] })], { day: theDay });
    // 25 ottobre 2026, dopo le 3: Roma è a +01:00; «+02:00» è lo scostamento di ieri.
    expect(check(one('2026-10-25T18:00:00+02:00', '2026-10-25T19:00:00+02:00'))).toBe(
      'offset_mismatch',
    );
    expect(check(one('2026-10-25T18:00:00+01:00', '2026-10-25T19:00:00+01:00'))).toBeNull();
    expect(check(one('2026-10-25T01:00:00+02:00', '2026-10-25T01:30:00+02:00'))).toBeNull();
    // UTC esplicito e «Z» sono istanti certi.
    expect(check(one('2026-10-25T17:00:00+00:00', '2026-10-25T18:00:00+00:00'))).toBeNull();
    expect(check(one('2026-10-25T17:00:00Z', '2026-10-25T18:00:00Z'))).toBeNull();
    // 28 marzo 2027: le 2:30 non esistono, messaggio dedicato invece di un giro senza fine.
    expect(check(one('2027-03-28T02:30:00+01:00', '2027-03-28T03:30:00+02:00', '2027-03-28'))).toBe(
      'nonexistent_time',
    );
    // La validazione comune (usata anche dall'app) non blocca le liste già salvate.
    expect(code(one('2026-10-25T18:00:00+02:00', '2026-10-25T19:00:00+02:00'))).toBeNull();
  });
});

describe('Todo tools authorization and presentation', () => {
  const repo = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    save: vi.fn(),
    history: vi.fn(async () => []),
  } as TodoRepository;
  it('checks the live gate even on direct execution, including missing checker', async () => {
    const tool = createTodoTools(repo).find((t) => t.id === 'todo_lists');
    await expect(tool?.execute({}, { userId: 'A' } as never)).resolves.toMatchObject({
      error: 'skill_disabled',
    });
    expect(repo.list).not.toHaveBeenCalled();
  });
  it('passes authenticated identity and returns canonical list blocks; provider schemas serialize', async () => {
    const saved = TodoList.parse({ ...list([]), revision: 1, updatedAt: new Date().toISOString() });
    const get = vi.fn(async () => saved);
    const tools = createTodoTools({ ...repo, get }, { canUse: async () => true });
    for (const tool of tools) {
      expect(tool.requiredScopes).toEqual(['chat']);
      expect(() => z.toJSONSchema(tool.inputSchema)).not.toThrow();
      expect(() => z.toJSONSchema(tool.outputSchema)).not.toThrow();
    }
    const tool = tools.find((t) => t.id === 'todo_get');
    const out = await tool?.execute({ id: saved.id }, { userId: 'A' } as never);
    expect(get).toHaveBeenCalledWith('A', saved.id);
    expect(ContentBlock.parse(tool?.present?.({ id: saved.id }, out as never))).toEqual({
      kind: 'todo_list',
      list: saved,
    });
  });
});
