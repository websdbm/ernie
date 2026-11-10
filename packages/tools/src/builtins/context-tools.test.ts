import { randomUUID } from 'node:crypto';
import { RunContext } from '@ernie/agent-core';
import { createLogger } from '@ernie/observability';
import { TodoItem, TodoList } from '@ernie/protocol';
import { describe, expect, it, vi } from 'vitest';
import { memoryToolCallRecorder } from '../audit.js';
import { createGuardedTool } from '../executor.js';
import type { ToolContext } from '../types.js';
import { type ContextToolsDeps, createContextTools } from './context-tools.js';

const listId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const slotId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
interface Results {
  day_snapshot: {
    date: string;
    coverage: { source: string; status: string }[];
    tasks: unknown[];
    routines: unknown[];
    reminders: unknown[];
  };
  resolve_target: { status: string; candidates: unknown[] };
  change_preview: { changes: unknown[]; proof: unknown };
  change_apply: { verified: boolean; list: TodoList; alreadyApplied: boolean };
  check_result: { status: string; mismatches: string[] };
}
const ctx = (userId = 'owner', sessionId = 'session'): ToolContext => ({
  userId,
  sessionId,
  requestId: 'request',
  scopes: ['chat'],
  modelClass: 'heavy',
  run: new RunContext(userId, ['chat'], 0),
  device: { timezone: 'Europe/Rome' },
});
const makeList = () =>
  TodoList.parse({
    id: listId,
    name: 'Giornata',
    mode: 'scheduled',
    day: '2026-11-10',
    timezone: 'Europe/Rome',
    revision: 2,
    updatedAt: '2026-11-10T08:00:00Z',
    items: [
      {
        id: taskId,
        title: 'Impasto',
        notes: 'Ricetta confermata',
        status: 'done',
        slots: [
          {
            id: slotId,
            startAt: '2026-11-10T10:00:00+01:00',
            endAt: '2026-11-10T10:30:00+01:00',
            reminderMinutes: 20,
          },
        ],
      },
      { id: otherId, title: 'Cottura', dependsOn: [{ taskId, lagMinutes: 180 }], slots: [] },
    ],
  });

function fixture() {
  let current = makeList();
  let clock = new Date('2026-11-10T07:00:00Z');
  const deps: ContextToolsDeps = {
    canUse: vi.fn(async () => true),
    now: () => clock,
    todo: {
      list: vi.fn(async () => [current]),
      get: vi.fn(async () => current),
      history: vi.fn(async () => []),
      save: vi.fn(async (_u, input) => {
        current = TodoList.parse({
          ...input,
          revision: current.revision + 1,
          updatedAt: clock.toISOString(),
        });
        return current;
      }),
    },
    shopping: {
      lists: vi.fn(async () => [{ id: 'spesa', name: 'Spesa', status: 'active', open: 2 }]),
    } as unknown as ContextToolsDeps['shopping'],
    reminders: {
      list: vi.fn(async () => [
        {
          id: 'r1',
          text: 'Visita',
          at: new Date('2026-11-10T09:00:00Z'),
          eventAt: new Date('2026-11-10T10:00:00Z'),
        },
      ]),
    },
    brain: {
      agenda: vi.fn(async (_u, q) => ({
        date: q.date,
        timeZone: q.timeZone,
        subjects: [],
        entries: [],
      })),
      search: vi.fn(async () => []),
    },
    sites: vi.fn(async () => [{ id: 'site', domain: 'example.it', serverName: 'Server uno' }]),
  };
  const tools = createContextTools(deps);
  const call = async <K extends keyof Results>(
    id: K,
    input: unknown,
    context = ctx(),
  ): Promise<Results[K]> => {
    const tool = tools.find((t) => t.id === id);
    if (!tool) throw new Error(`Tool missing: ${id}`);
    return tool.outputSchema.parse(
      await tool.execute(tool.inputSchema.parse(input), context),
    ) as Results[K];
  };
  return {
    deps,
    tools,
    call,
    current: () => current,
    set: (value: TodoList) => {
      current = value;
    },
    advance: () => {
      clock = new Date(clock.getTime() + 600_001);
    },
  };
}
const change = {
  kind: 'todo',
  id: listId,
  revision: 2,
  patch: { items: [{ id: taskId, changes: { title: 'Prepara impasto' } }] },
};

describe('deterministic context tools', () => {
  it('bounds large previews through the real executor and declares omitted differences without damaging the proof', async () => {
    const f = fixture();
    f.set(
      TodoList.parse({
        ...f.current(),
        mode: 'simple',
        day: null,
        items: Array.from({ length: 30 }, (_, i) => ({
          id: randomUUID(),
          title: `Task ${i}`,
          notes: 'a'.repeat(2000),
        })),
      }),
    );
    const input = {
      ...change,
      patch: {
        items: f
          .current()
          .items.map((item) => ({ id: item.id, changes: { notes: 'b'.repeat(2000) } })),
      },
    };
    const spec = f.tools.find((tool) => tool.id === 'change_preview');
    if (!spec) throw new Error('Missing preview');
    const guarded = createGuardedTool(
      spec,
      {
        policyRules: {},
        audit: memoryToolCallRecorder(),
        logger: createLogger({ name: 'test', level: 'silent' }),
      },
      { current: ctx() },
    );
    const raw = await f.call('change_preview', input);
    const result = (await guarded.execute?.(input, {} as never)) as typeof raw & {
      coverage: {
        totalChanges: number;
        shownChanges: number;
        omittedChanges: number;
        shortenedValues: number;
        truncated: boolean;
      };
    };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(8000);
    expect(result.proof).toEqual(raw.proof);
    expect(result.coverage.totalChanges).toBe(30);
    expect(result.coverage.shownChanges).toBe(result.changes.length);
    expect(result.coverage.omittedChanges).toBe(30 - result.changes.length);
    expect(result.coverage.omittedChanges).toBeGreaterThan(0);
    expect(result.coverage.shortenedValues).toBeGreaterThan(0);
    expect(result.coverage.truncated).toBe(true);
    const applied = await f.call('change_apply', { ...input, proof: result.proof });
    expect(applied.list.items.every((item) => item.notes === 'b'.repeat(2000))).toBe(true);
  });
  it('reads sources concurrently, declares missing calendar and preserves alert versus event', async () => {
    const f = fixture();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.deps.todo.list = vi.fn(async () => {
      started++;
      await gate;
      return [f.current()];
    });
    f.deps.reminders.list = vi.fn(async () => {
      started++;
      await gate;
      return [
        {
          id: 'r',
          text: 'Visita',
          at: new Date('2026-11-10T09:00Z'),
          eventAt: new Date('2026-11-10T10:00Z'),
        },
      ];
    });
    const pending = f.call('day_snapshot', {});
    await vi.waitFor(() => expect(started).toBe(2));
    release();
    const result = await pending;
    expect(result.date).toBe('2026-11-10');
    expect(result.coverage).toContainEqual(
      expect.objectContaining({ source: 'calendar', status: 'unavailable' }),
    );
    expect(result.reminders[0]).toMatchObject({
      alertAt: '2026-11-10T09:00:00.000Z',
      eventAt: '2026-11-10T10:00:00.000Z',
    });
    expect(f.deps.brain.agenda).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ includePrivate: false }),
    );
    expect(f.deps.todo.save).not.toHaveBeenCalled();
  });
  it('does not leak data when a skill is disabled or revoked during the read', async () => {
    const f = fixture();
    f.deps.canUse = vi.fn(async (_u, domain) => domain !== 'brain');
    f.deps.todo.list = vi.fn(async () => {
      f.deps.canUse = vi.fn(async () => false);
      return [f.current()];
    });
    const result = await f.call('day_snapshot', {});
    expect(result.tasks).toEqual([]);
    expect(result.routines).toEqual([]);
    expect(f.deps.brain.agenda).not.toHaveBeenCalled();
  });
  it('returns partial coverage on one failed source without hiding the other sources', async () => {
    const f = fixture();
    f.deps.reminders.list = vi.fn(async () => {
      throw new Error('database failed');
    });
    const result = await f.call('day_snapshot', {});
    expect(result.tasks).toHaveLength(2);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({ source: 'reminders', status: 'unavailable' }),
    );
  });
  it('resolves exact unique names, asks about unmatched names even when only one list exists', async () => {
    const f = fixture();
    expect(
      await f.call('resolve_target', { kind: 'shopping', query: 'cose da acquistare' }),
    ).toMatchObject({ status: 'choose', candidates: [{ id: 'spesa' }] });
    expect(await f.call('resolve_target', { kind: 'shopping', query: 'SPESA' })).toMatchObject({
      status: 'resolved',
    });
    expect(f.deps.shopping.lists).toHaveBeenCalledWith('owner');
  });
  it('does not silently merge namesakes or read private notes', async () => {
    const f = fixture();
    f.deps.brain.search = vi.fn(async () =>
      [1, 2].map((n) => ({
        path: `Persone/Ada-${n}`,
        title: 'Ada',
        type: 'persona',
        created: '',
        refersFrom: null,
        refersTo: null,
        place: null,
        links: [],
        private: false,
        passage: 'not exposed',
      })),
    );
    expect(await f.call('resolve_target', { kind: 'person', query: 'Ada' })).toMatchObject({
      status: 'choose',
      candidates: [{ id: 'Persone/Ada-1' }, { id: 'Persone/Ada-2' }],
    });
    expect(f.deps.brain.search).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ includePrivate: false }),
    );
  });
  it('checks permissions again for every call, without touching denied repositories', async () => {
    const f = fixture();
    f.deps.canUse = vi.fn(async () => false);
    await expect(
      f.call('resolve_target', { kind: 'site', query: 'example.it' }),
    ).rejects.toMatchObject({ code: 'skill_disabled' });
    expect(f.deps.sites).not.toHaveBeenCalled();
  });
  it('keeps the advanced-model requirement for SSH inventory resolution', async () => {
    const f = fixture();
    await expect(
      f.call(
        'resolve_target',
        { kind: 'site', query: 'example.it' },
        { ...ctx(), modelClass: 'standard' },
      ),
    ).rejects.toMatchObject({ code: 'advanced_model_required' });
    expect(f.deps.sites).not.toHaveBeenCalled();
    expect(await f.call('resolve_target', { kind: 'site', query: 'example.it' })).toMatchObject({
      status: 'resolved',
    });
  });
  it('previews and applies a narrow patch, preserving statuses, notes, slots and other tasks', async () => {
    const f = fixture();
    const original = structuredClone(f.current());
    const preview = await f.call('change_preview', change);
    expect(preview.changes).toEqual([
      { field: 'Prepara impasto.title', before: 'Impasto', after: 'Prepara impasto' },
    ]);
    expect(f.deps.todo.save).not.toHaveBeenCalled();
    const result = await f.call('change_apply', { ...change, proof: preview.proof });
    expect(result.verified).toBe(true);
    expect(result.list.items).toEqual([
      { ...original.items[0], title: 'Prepara impasto' },
      original.items[1],
    ]);
    expect(result.list.revision).toBe(3);
    const retried = await f.call('change_apply', { ...change, proof: preview.proof });
    expect(retried.alreadyApplied).toBe(true);
    expect(f.deps.todo.save).toHaveBeenCalledTimes(1);
  });
  it('converts a schedule to a simple list preserving hierarchy but explicitly previews removal of reminders', async () => {
    const f = fixture();
    const request = { ...change, patch: { mode: 'simple' } };
    const preview = await f.call('change_preview', request);
    expect(preview.changes).toContainEqual(
      expect.objectContaining({ field: 'Impasto.slots', after: [] }),
    );
    const result = await f.call('change_apply', { ...request, proof: preview.proof });
    expect(result.list.day).toBeNull();
    expect(result.list.items[0]?.slots).toEqual([]);
    expect(result.list.items[1]?.dependsOn[0]?.taskId).toBe(taskId);
  });
  it('rejects modified payloads, another account, another session and expired previews', async () => {
    const f = fixture();
    const { proof } = await f.call('change_preview', change);
    for (const context of [ctx('other'), ctx('owner', 'other-session')])
      await expect(f.call('change_apply', { ...change, proof }, context)).rejects.toMatchObject({
        code: 'invalid_preview',
      });
    await expect(
      f.call('change_apply', { ...change, patch: { name: 'Altered' }, proof }),
    ).rejects.toMatchObject({ code: 'invalid_preview' });
    f.advance();
    await expect(f.call('change_apply', { ...change, proof })).rejects.toMatchObject({
      code: 'invalid_preview',
    });
    expect(f.deps.todo.save).not.toHaveBeenCalled();
  });
  it('rejects concurrent changes rather than overwriting them', async () => {
    const f = fixture();
    const { proof } = await f.call('change_preview', change);
    f.set({ ...f.current(), revision: 3, name: 'Changed on phone' });
    await expect(f.call('change_apply', { ...change, proof })).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect(f.deps.todo.save).not.toHaveBeenCalled();
  });
  it('never starts a write when cancelled during the final asynchronous permission check', async () => {
    const f = fixture();
    const { proof } = await f.call('change_preview', change);
    const controller = new AbortController();
    let checks = 0;
    const lastCheck = Promise.withResolvers<boolean>();
    f.deps.canUse = vi.fn(async () => {
      checks++;
      return checks === 4 ? lastCheck.promise : true;
    });
    const pending = f.call(
      'change_apply',
      { ...change, proof },
      { ...ctx(), signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(checks).toBe(4));
    controller.abort();
    lastCheck.resolve(true);
    await assertion;
    expect(f.deps.todo.save).not.toHaveBeenCalled();
  });
  it('rejects unknown task IDs and inconsistent dependency changes before saving', async () => {
    const f = fixture();
    await expect(
      f.call('change_preview', {
        ...change,
        patch: { items: [{ id: listId, changes: { title: 'Ghost' } }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(
      f.call('change_preview', {
        ...change,
        patch: { items: [{ id: taskId, changes: { dependsOn: [{ taskId: otherId }] } }] },
      }),
    ).rejects.toThrow();
    expect(f.deps.todo.save).not.toHaveBeenCalled();
  });
  it('does not claim verification when a concurrent write follows saving', async () => {
    const f = fixture();
    const { proof } = await f.call('change_preview', change);
    f.deps.todo.save = vi.fn(async () => f.current());
    await expect(f.call('change_apply', { ...change, proof })).rejects.toMatchObject({
      code: 'verification_conflict',
    });
  });
  it('checks the stored schedule and reports missing or mismatched items honestly', async () => {
    const f = fixture();
    expect(
      await f.call('check_result', { kind: 'todo', id: listId, expected: { mode: 'scheduled' } }),
    ).toMatchObject({ status: 'verified' });
    expect(
      await f.call('check_result', {
        kind: 'todo',
        id: listId,
        expected: { mode: 'simple', items: [{ id: taskId, changes: { title: 'Other' } }] },
      }),
    ).toMatchObject({ status: 'partial', mismatches: ['mode', `item:${taskId}.title`] });
    f.deps.todo.get = vi.fn(async () => null);
    expect(
      await f.call('check_result', { kind: 'todo', id: listId, expected: { name: 'Giornata' } }),
    ).toMatchObject({ status: 'missing' });
  });
  it('all mutation paths still declare policy writes and require chat scope', () => {
    const f = fixture();
    expect(f.tools.find((t) => t.id === 'change_apply')).toMatchObject({
      risk: { write: true, readsPrivate: true },
      requiredScopes: ['chat'],
    });
    expect(TodoItem.parse({ id: taskId, title: 'Test' }).status).toBe('pending');
  });
});
