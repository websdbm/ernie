import { TodoItem, TodoList } from '@ernie/protocol';
import { describe, expect, it } from 'vitest';
import { renderContinuity } from './continuity.js';

const list = TodoList.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Casa nuova',
  mode: 'simple',
  day: null,
  timezone: 'Europe/Rome',
  revision: 2,
  updatedAt: '2026-10-22T10:00:00Z',
  items: [
    TodoItem.parse({ id: '22222222-2222-4222-8222-222222222222', title: 'Verificare lavori' }),
  ],
});
const base = {
  todos: [list],
  shopping: [{ id: 'spesa', name: 'Spesa', open: 2 }],
  summaries: [],
  day: '2026-10-22',
  query: 'Riprendiamo i lavori della casa nuova',
};
describe('continuity from canonical sources', () => {
  it('keeps IDs and revisions across chats without creating work or reminders', () => {
    const value = renderContinuity(base);
    expect(value.text).toContain(list.id);
    expect(value.text).toContain('"revision":2');
    expect(value.text).toContain('Verificare lavori');
    expect(value.text).toContain('"name":"Spesa"');
    expect(value.untrusted).toBe(false);
    expect(base.todos[0]).toEqual(list);
  });
  it('removes completed and cancelled tasks immediately on the next read', () => {
    for (const status of ['done', 'cancelled'] as const)
      expect(
        renderContinuity({
          ...base,
          todos: [{ ...list, items: list.items.map((i) => ({ ...i, status })) }],
        }).text,
      ).not.toContain('Verificare lavori');
  });
  it('labels historical hints as uncertain and never turns them into current tasks', () => {
    const summaries = [
      {
        session_id: 'old',
        covered_until: new Date('2026-10-20'),
        summary: {
          topics: [],
          done: ['Controllati i lavori della casa nuova'],
          open: ['Restano i lavori della casa nuova'],
          preferences: [],
          facts: [],
          state: '',
        },
      },
    ];
    const value = renderContinuity({ ...base, summaries });
    expect(value.text).toContain('Spunto storico da verificare');
    expect(value.untrusted).toBe(true);
    expect(
      renderContinuity({ ...base, summaries, query: 'Parliamo di musica' }).text,
    ).not.toContain('Spunto storico');
  });
  it('caps prompt length, preserves whole records and rejects malformed sources', () => {
    expect(renderContinuity({ ...base, todos: [{}] }).text).not.toContain(list.id);
    const value = renderContinuity(
      {
        ...base,
        shopping: Array.from({ length: 100 }, () => ({
          id: 'x',
          name: 'x'.repeat(2000),
          open: 100,
        })),
      },
      1100,
    );
    expect(value.text.length).toBeLessThanOrEqual(1100);
    expect(renderContinuity(base, 0).text).toBe('');
  });
});

// Real PostgreSQL/RLS regression, enabled only with explicit test database environment.
import { randomUUID } from 'node:crypto';
import { createPool } from '@ernie/db';
import { createContinuityReader } from './continuity.js';

it.skipIf(!process.env.MIGRATIONS_DATABASE_URL || !process.env.DATABASE_URL)(
  'reads latest canonical state with real user isolation',
  async () => {
    const owner = createPool({ connectionString: process.env.MIGRATIONS_DATABASE_URL! }),
      app = createPool({ connectionString: process.env.DATABASE_URL! });
    const a = randomUUID(),
      b = randomUUID(),
      id = randomUUID(),
      session = randomUUID();
    try {
      await owner.query(
        "INSERT INTO users(id,display_name) VALUES($1,'Continuity A'),($2,'Continuity B')",
        [a, b],
      );
      await owner.query(
        "INSERT INTO todo_lists(user_id,id,name,mode,timezone,revision,items) VALUES($1,$2,'Casa unica','simple','Europe/Rome',1,$3)",
        [a, id, JSON.stringify(list.items)],
      );
      const read = createContinuityReader(app);
      expect((await read(a, session, 'Casa')).text).toContain('Casa unica');
      expect((await read(b, session, 'Casa')).text).not.toContain('Casa unica');
      expect(
        (await read(a, session, 'Casa', 'Europe/Rome', { todo: false, shopping: false })).text,
      ).not.toContain('Casa unica');
      await owner.query('UPDATE todo_lists SET items=$2::jsonb, revision=2 WHERE user_id=$1', [
        a,
        JSON.stringify(list.items.map((i) => ({ ...i, status: 'done' }))),
      ]);
      expect((await read(a, session, 'Casa')).text).not.toContain('Verificare lavori');
    } finally {
      await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[a, b]]);
      await app.end();
      await owner.end();
    }
  },
);
