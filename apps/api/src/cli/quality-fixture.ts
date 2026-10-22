/** Adapter del corpus: esclusivamente database/Redis dedicati, mai account reali. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAutomationQueue } from '@ernie/automations';
import { createPool } from '@ernie/db';
import { createMemoryQueue } from '@ernie/memory';
import { createRecipeRepository } from '@ernie/tools';
import { Redis } from 'ioredis';
import { API_KEY_PREFIX, hashApiKey } from '../auth.js';

interface Config {
  runId: string;
  maxSpendUsd: number;
  apiKey: string;
  wsUrl: string;
}
interface Seed {
  shopping?: Array<{ name: string; items?: Array<{ name: string; quantity?: string }> }>;
  todos?: Array<{ name: string; items: Array<{ title: string; status: 'pending' | 'done' }> }>;
  brain?: Array<{ title: string; body: string }>;
  recipes?: Array<{ title: string; ingredients: string[]; steps: string[] }>;
}
interface Ref {
  caseId: string;
  sessionId: string;
}
interface List {
  id: string;
  name: string;
  items: Array<{ id: string; name: string; quantity: string | null; checked: boolean }>;
}
interface Todo {
  id: string;
  name: string;
  mode: 'simple' | 'scheduled';
  items: Array<{ id: string; title: string; status: string; slots: unknown[] }>;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createFixtureDriver(config: Config) {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!url || !/^\/ernie_perf_[a-z0-9_]+$/.test(new URL(url).pathname))
    throw new Error('Serve un database dedicato ernie_perf_*');
  if (!redisUrl || process.env.EVAL_ISOLATED_STACK !== '1')
    throw new Error('Serve uno stack di collaudo isolato');
  if (!config.apiKey.startsWith(API_KEY_PREFIX) || config.apiKey.length < 20)
    throw new Error('Serve una chiave fixture Ernie valida');
  const base = new URL(config.wsUrl);
  if (base.pathname !== '/v1/ws') throw new Error('Usare il WebSocket /v1/ws');
  base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:';
  base.pathname = '/';
  if (!['127.0.0.1', 'localhost'].includes(base.hostname))
    throw new Error('Usare il tunnel locale dello stack isolato');
  const owner = createPool({ connectionString: url, max: 2 });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queues = [createMemoryQueue(redis), createAutomationQueue(redis)];
  const accounts: string[] = [];
  let userId = '';
  let closed = false;
  let currentCase = 'initialization';
  const settings = {
    evaluationRunId: config.runId,
    evaluationExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    emailNotifications: false,
    proactive: false,
    learnLexicon: false,
    dailyBudgetUsd: config.maxSpendUsd,
    skills: {
      ssh: false,
      messaggi: false,
      sentinelle: false,
      todo: true,
      ricette: true,
      second_brain: true,
      shopping_list: true,
      ricordami: true,
    },
  };
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Fixture API ${method} ${path.split('?')[0]}: ${response.status}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
  async function create() {
    const nextId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users(id,display_name,settings) VALUES($1,$2,$3)', [
        nextId,
        'Collaudo qualità Ernie',
        JSON.stringify(settings),
      ]);
      await client.query(
        "INSERT INTO api_keys(user_id,label,key_hash,scopes) VALUES($1,'quality-evaluation',$2,ARRAY['chat'])",
        [nextId, hashApiKey(config.apiKey)],
      );
      await client.query('UPDATE usage_accounts SET is_test=true WHERE user_id=$1', [nextId]);
      await client.query('COMMIT');
      userId = nextId;
      accounts.push(userId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function verify() {
    if (!userId) await create();
    const result = await owner.query<{
      settings: typeof settings;
      is_test: boolean;
      devices: number;
    }>(
      `SELECT u.settings,a.is_test,(SELECT count(*)::int FROM devices WHERE user_id=u.id) devices FROM users u JOIN usage_accounts a ON a.user_id=u.id WHERE u.id=$1`,
      [userId],
    );
    const row = result.rows[0];
    const me = await api<{ userId: string }>('/v1/me');
    if (
      !row ||
      row.settings.evaluationRunId !== config.runId ||
      !row.is_test ||
      row.devices !== 0 ||
      row.settings.emailNotifications !== false ||
      row.settings.proactive !== false ||
      row.settings.skills.ssh !== false ||
      row.settings.skills.messaggi !== false ||
      row.settings.skills.sentinelle !== false
    )
      throw new Error('Fixture non isolata');
    return {
      userId,
      authenticatedUserId: me.userId,
      testRunId: row.settings.evaluationRunId,
      markedTest: true as const,
      notificationsSuppressed: true as const,
      dangerousToolsDisabled: true as const,
      budgetCapUsd: row.settings.dailyBudgetUsd,
      expiresAt: row.settings.evaluationExpiresAt,
    };
  }
  async function cleanup(_input?: Ref) {
    if (!userId) return;
    const result = await owner.query(
      "UPDATE users SET settings=jsonb_set(settings,'{killSwitch}','true') WHERE id=$1 AND settings->>'evaluationRunId'=$2 RETURNING id",
      [userId, config.runId],
    );
    if (!result.rowCount) throw new Error('Identità fixture cambiata: cleanup interrotto');
    await owner.query('UPDATE automations SET enabled=false WHERE user_id=$1', [userId]);
    const deadline = Date.now() + 60_000;
    // Attende i job attivi; rimuove solo quelli di questo account e poi ricontrolla.
    let quiet = 0;
    while (Date.now() < deadline && quiet < 3) {
      let active = 0;
      for (const queue of queues) {
        const jobs = await queue.getJobs(
          ['active', 'waiting', 'delayed', 'failed', 'completed'],
          0,
          1000,
        );
        for (const job of jobs) {
          if ((job.data?.userId ?? job.data?.episode?.userId) !== userId) continue;
          if ((await job.getState()) === 'active') active++;
          else await job.remove();
        }
      }
      quiet = active ? 0 : quiet + 1;
      await wait(500);
    }
    if (quiet < 3) throw new Error('Job fixture ancora attivi: non eliminare account');
    const metricsDir = process.env.EVAL_METRICS_DIR;
    if (metricsDir) {
      const observations = await owner.query(
        `SELECT request_id AS "requestId",source,app_version AS "appVersion",input_mode AS "inputMode",
          outcome,reconnected,metrics FROM performance_observations WHERE user_id=$1 ORDER BY created_at`,
        [userId],
      );
      await mkdir(metricsDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(metricsDir, `${currentCase.replace(/[^a-z0-9_-]/gi, '_')}.json`),
        `${JSON.stringify(observations.rows, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    const deletion = await owner.connect();
    try {
      await deletion.query('BEGIN');
      await deletion.query("SET LOCAL statement_timeout='60s'");
      // La proiezione ricette/media usa questo stesso lock durante il lavoro asincrono.
      await deletion.query('SELECT pg_advisory_xact_lock(hashtextextended($1,41))', [userId]);
      await deletion.query("DELETE FROM users WHERE id=$1 AND settings->>'evaluationRunId'=$2", [
        userId,
        config.runId,
      ]);
      await deletion.query('COMMIT');
    } catch (error) {
      await deletion.query('ROLLBACK');
      throw error;
    } finally {
      deletion.release();
    }
    userId = '';
  }
  try {
    await create();
  } catch (error) {
    await Promise.all(queues.map((q) => q.close()));
    await redis.quit();
    await owner.end();
    throw error;
  }
  return {
    verify,
    async prepare(input: Ref & { seed: Seed }) {
      currentCase = input.caseId;
      if (!userId) await create();
      await verify();
      for (const list of input.seed.shopping ?? []) {
        const created = await api<{ block: { listId: string } }>('/v1/shopping/lists', 'POST', {
          name: list.name,
        });
        for (const item of list.items ?? [])
          await api(`/v1/shopping/lists/${created.block.listId}/items`, 'POST', item);
      }
      for (const list of input.seed.todos ?? [])
        await api('/v1/todo/lists', 'POST', {
          id: randomUUID(),
          name: list.name,
          mode: 'simple',
          day: null,
          timezone: 'Europe/Rome',
          items: list.items.map((item, position) => ({ ...item, id: randomUUID(), position })),
        });
      for (const note of input.seed.brain ?? []) await api('/v1/brain/notes', 'POST', note);
      for (const recipe of input.seed.recipes ?? [])
        await createRecipeRepository(owner).save(userId, recipe);
    },
    async snapshot(_input: Ref) {
      await verify();
      const [reminders, shopping, todos, brain, recipes] = await Promise.all([
        api<{ reminders: Array<{ id: string; text: string; at?: string; eventAt?: string }> }>(
          '/v1/reminders',
        ),
        api<{ lists: Array<{ id: string }> }>('/v1/shopping/lists'),
        api<{ lists: Todo[] }>('/v1/todo/lists'),
        api<{ notes: Array<{ path: string; title: string }> }>('/v1/brain/notes?limit=100'),
        api<{
          recipes: Array<{ id: string; title: string; ingredients: string[]; steps: string[] }>;
        }>('/v1/recipes?limit=100'),
      ]);
      const lists = await Promise.all(
        shopping.lists.map(async (list) => {
          const { block } = await api<{
            block: { listId: string; name: string; items: List['items'] };
          }>(`/v1/shopping/lists/${list.id}`);
          return {
            id: block.listId,
            name: block.name,
            items: block.items.map((i) => ({ ...i, quantity: i.quantity ?? null })),
          };
        }),
      );
      const notes = await Promise.all(
        brain.notes.map((n) =>
          api<{ note: { path: string; title: string; body: string } }>(
            `/v1/brain/note?path=${encodeURIComponent(n.path)}`,
          ),
        ),
      );
      return {
        reminders: reminders.reminders.map((r) => ({
          ...r,
          at: r.at ?? '',
          eventAt: r.eventAt ?? null,
        })),
        shopping: lists,
        todos: todos.lists,
        brain: notes.map((n) => ({ path: n.note.path, title: n.note.title, body: n.note.body })),
        recipes: recipes.recipes,
      };
    },
    async spentUsd() {
      const r = await owner.query<{ amount: string }>(
        'SELECT COALESCE(sum(COALESCE(reported_usd,estimated_usd)),0)::text amount FROM usage_ledger WHERE user_id=ANY($1::uuid[])',
        [accounts],
      );
      return Number(r.rows[0]?.amount ?? 0);
    },
    cleanup,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await cleanup();
        const revoked = await fetch(new URL('/v1/me', base), {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (revoked.status !== 401) throw new Error('Revoca fixture non confermata');
      } finally {
        await Promise.all(queues.map((q) => q.close()));
        await redis.quit();
        await owner.end();
      }
    },
  };
}
