import { randomUUID } from 'node:crypto';
import { RunContext } from '@ernie/agent-core';
import { createPool, type Pool } from '@ernie/db';
import { TodoItem } from '@ernie/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../types.js';
import { createContextTools } from './context-tools.js';
import { createShoppingListRepository } from './shopping.js';
import { createTodoRepository, type TodoRepository } from './todo.js';

const ownerURL = process.env.MIGRATIONS_DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
describe.skipIf(!ownerURL || !password)(
  'context tools with real account isolation and revisions',
  () => {
    let owner: Pool, app: Pool, todo: TodoRepository;
    const a = randomUUID(),
      b = randomUUID();
    let tools: ReturnType<typeof createContextTools>;
    const context = (userId: string): ToolContext => ({
      userId,
      sessionId: 'test-session',
      requestId: randomUUID(),
      scopes: ['chat'],
      run: new RunContext(userId, ['chat'], 0),
    });
    async function call(id: string, input: unknown, userId = a): Promise<unknown> {
      const tool = tools.find((t) => t.id === id);
      if (!tool) throw new Error('missing');
      return tool.outputSchema.parse(
        await tool.execute(tool.inputSchema.parse(input), context(userId)),
      );
    }
    beforeAll(async () => {
      const url = new URL(ownerURL as string);
      // These tests deliberately require a local disposable database, never a shared production URL.
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Local test database required');
      owner = createPool({ connectionString: ownerURL as string, max: 2 });
      url.username = 'ernie_app';
      url.password = password as string;
      app = createPool({ connectionString: url.toString(), max: 4 });
      await owner.query(
        "INSERT INTO users(id,display_name) VALUES($1,'Context test A'),($2,'Context test B')",
        [a, b],
      );
      todo = createTodoRepository(app);
      tools = createContextTools({
        canUse: async () => true,
        todo,
        shopping: createShoppingListRepository(app),
        reminders: { list: async () => [] },
        brain: { search: async () => [] },
        sites: async () => [],
      });
    });
    afterAll(async () => {
      await owner?.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[a, b]]);
      await app?.end();
      await owner?.end();
    });
    it('patches once across retries, preserves history and rejects another device revision', async () => {
      const list = await todo.save(a, {
        id: randomUUID(),
        name: 'Test',
        mode: 'simple',
        day: null,
        timezone: 'Europe/Rome',
        items: [TodoItem.parse({ id: randomUUID(), title: 'Primo', notes: 'Da conservare' })],
      });
      const request = {
        kind: 'todo',
        id: list.id,
        revision: list.revision,
        patch: { name: 'Nuovo titolo' },
      };
      const preview = (await call('change_preview', request)) as { proof: unknown };
      await expect(
        call('change_apply', { ...request, proof: preview.proof }),
      ).resolves.toMatchObject({ verified: true, list: { revision: 2 } });
      await expect(
        call('change_apply', { ...request, proof: preview.proof }),
      ).resolves.toMatchObject({ alreadyApplied: true });
      expect(await todo.history(a, list.id)).toHaveLength(2);
      expect((await todo.get(a, list.id))?.items).toEqual(list.items);
      const next = { ...request, revision: 2, patch: { name: 'Terza versione' } };
      const stale = (await call('change_preview', next)) as { proof: unknown };
      const { updatedAt: _updatedAt, ...saveInput } = list;
      await todo.save(a, { ...saveInput, revision: 2, name: 'Modifica da telefono' });
      await expect(call('change_apply', { ...next, proof: stale.proof })).rejects.toMatchObject({
        code: 'revision_conflict',
      });
      expect((await todo.get(a, list.id))?.name).toBe('Modifica da telefono');
    });
    it('cannot read, resolve, verify or preview the other account’s objects', async () => {
      const list = await todo.save(a, {
        id: randomUUID(),
        name: 'Private list',
        mode: 'simple',
        day: null,
        timezone: 'UTC',
        items: [],
      });
      expect(
        await call('resolve_target', { kind: 'todo', query: 'Private list' }, b),
      ).toMatchObject({ status: 'none', candidates: [] });
      expect(
        await call(
          'check_result',
          { kind: 'todo', id: list.id, expected: { name: 'Private list' } },
          b,
        ),
      ).toMatchObject({ status: 'missing' });
      await expect(
        call(
          'change_preview',
          { kind: 'todo', id: list.id, revision: 1, patch: { name: 'Altered' } },
          b,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  },
);
