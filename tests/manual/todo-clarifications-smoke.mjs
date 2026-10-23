// Synthetic-account staging smoke. Uses real LLM credits; never targets an existing account.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadConfig } from '/app/packages/config/dist/index.js';
import { createPool } from '/app/packages/db/dist/index.js';
import { createSoulRepository } from '/app/packages/soul/dist/index.js';

if (process.env.RUN_TODO_CLARIFICATION_SMOKE !== '1')
  throw new Error('Explicit opt-in required; run inside the staging API container.');

const requireApi = createRequire('/app/apps/api/package.json');
const WebSocket = createRequire(requireApi.resolve('@fastify/websocket'))('ws');
const { Redis } = requireApi('ioredis');
const cfg = loadConfig(),
  pool = createPool({ connectionString: cfg.db.migrationsUrl, max: 2 }),
  redis = new Redis(cfg.redis.url);
const userId = randomUUID(),
  sessionId = randomUUID(),
  key = `ernie_${randomBytes(32).toString('base64url')}`;
const base = 'https://ernie.staging3.eklettica.it',
  events = [];
let ws,
  seq = 0,
  active;
function send(type, payload, correlationId = randomUUID()) {
  ws.send(
    JSON.stringify({
      v: 1,
      id: randomUUID(),
      sessionId,
      correlationId,
      seq: seq++,
      ts: new Date().toISOString(),
      type,
      payload,
    }),
  );
  return correlationId;
}
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const found = events.find(predicate);
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      ws.off('message', on);
      reject(new Error('event timeout'));
    }, 150000);
    function on(data) {
      const e = JSON.parse(data.toString());
      if (predicate(e)) {
        clearTimeout(timer);
        ws.off('message', on);
        resolve(e);
      }
    }
    ws.on('message', on);
  });
}
async function api(path, method = 'GET', body, status = 200) {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
async function turn(text) {
  for (let attempt = 0; attempt < 5; attempt++) {
    active = send('user.message', {
      text,
      inputMode: 'text',
      locale: 'it-IT',
      device: { timezone: 'Europe/Rome', localTime: new Date().toISOString() },
    });
    const end = await waitFor(
      (e) =>
        e.correlationId === active &&
        ['assistant.completed', 'error', 'tool.confirmation.requested'].includes(e.type),
    );
    if (end.type === 'error' && end.payload.code === 'busy') {
      active = undefined;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const result = events.filter((e) => e.correlationId === active);
    console.log(
      JSON.stringify({
        turnEnd: end.type,
        text: result
          .filter((e) => e.type === 'assistant.text.completed')
          .map((e) => e.payload.text),
        tools: result
          .filter((e) => e.type === 'tool.completed')
          .map((e) => ({ toolId: e.payload.toolId, ok: e.payload.ok })),
      }),
    );
    assert.equal(end.type, 'assistant.completed', JSON.stringify(end.payload));
    active = undefined;
    return result;
  }
  throw new Error('Still busy after bounded retry');
}

const id = randomUUID(),
  fixedId = randomUUID(),
  day = '2030-01-15';
const localTime = (value) =>
  new Date(value).toLocaleTimeString('it-IT', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
  });
const snapshot = async () => (await api(`/v1/todo/lists/${id}`)).list;
const blocks = (es) => es.filter((e) => e.type === 'assistant.block').map((e) => e.payload.block);
const notSaved = (es) =>
  assert(
    !es.some((e) => e.type === 'tool.completed' && e.payload.toolId === 'todo_save'),
    'Must wait for the answer before saving',
  );
try {
  await pool.query(
    "INSERT INTO users(id,display_name,role,locale,settings) VALUES($1,'Collaudo chiarimenti Todo','member','it-IT',$2)",
    [
      userId,
      JSON.stringify({
        voiceOutput: false,
        emailNotifications: false,
        proactive: false,
        learnLexicon: false,
        dailyBudgetUsd: 0.5,
        skillsAvailable: { todo: true },
        skills: { todo: true, ssh: false, messaggi: false, sentinelle: false, ricordami: false },
      }),
    ],
  );
  await pool.query(
    "INSERT INTO api_keys(user_id,label,key_hash,scopes) VALUES($1,'temporary-todo-clarifications',$2,ARRAY['chat'])",
    [userId, createHash('sha256').update(key).digest()],
  );
  await pool.query('UPDATE usage_accounts SET is_test=true WHERE user_id=$1', [userId]);
  await createSoulRepository(pool).cloneDefaultsForUser(userId, 'todo-clarifications');
  const initial = (
    await api('/v1/todo/lists', 'POST', {
      id,
      name: 'Giornata collaudo',
      mode: 'scheduled',
      day,
      timezone: 'Europe/Rome',
      items: [
        {
          id: fixedId,
          title: 'Visita medica',
          kind: 'task',
          slots: [
            {
              id: randomUUID(),
              startAt: `${day}T11:00:00+01:00`,
              endAt: `${day}T11:45:00+01:00`,
              fixed: true,
              reminderMinutes: null,
            },
          ],
        },
      ],
    })
  ).list;
  ws = new WebSocket(`${base.replace('https:', 'wss:')}/v1/ws`, {
    headers: { authorization: `Bearer ${key}` },
  });
  ws.on('message', (data) => events.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  send('session.start', { clientInfo: { platform: 'test' } });
  await waitFor((e) => e.type === 'session.started');
  let es = await turn(
    'Nella mia lista Giornata collaudo del 15 gennaio 2030 aggiungi il meccanico: dura 30 minuti e posso andarci alle 12:30 oppure alle 14:00. I tragitti sono già compresi. Non ho scelto fra questi due orari. Mantieni la visita medica fissa e nessun promemoria. Una volta scelto, salva direttamente nella stessa lista.',
  );
  notSaved(es);
  assert.deepEqual(await snapshot(), initial);
  const choices = blocks(es).filter((b) => b.kind === 'choices');
  assert.equal(choices.length, 1, 'Expected one closed question');
  assert(choices[0].options.length >= 2 && choices[0].options.length <= 4);
  const choice = choices[0].options.find((o) => o.label.includes('12:30'));
  assert(choice, 'Choice must preserve the actual alternative');
  await turn(choice.label);
  const afterChoice = await snapshot();
  assert.equal(afterChoice.mode, 'scheduled');
  assert.deepEqual(
    afterChoice.items.find((i) => i.id === fixedId),
    initial.items[0],
  );
  const mechanic = afterChoice.items.find((i) => /meccanic/i.test(i.title));
  assert(mechanic);
  assert.equal(mechanic.slots.length, 1);
  assert.equal(localTime(mechanic.slots[0].startAt), '12:30');
  console.log(
    JSON.stringify({
      phase: 'closed-question',
      waited: true,
      answerApplied: true,
      originalAppointmentPreserved: true,
    }),
  );
  es = await turn(
    'Aggiungi alla stessa giornata anche Sopralluogo casa nuova: dura 30 minuti, subito dopo il meccanico, e poi ho il pomeriggio libero. Fra il meccanico e la casa nuova c’è un tragitto la cui durata non ti ho ancora detto: nel piano va considerato. Nessun promemoria, salva quando hai i dati necessari.',
  );
  notSaved(es);
  assert.deepEqual(await snapshot(), afterChoice);
  assert(
    !blocks(es).some((b) => b.kind === 'choices'),
    'Unknown journey duration requires a free answer',
  );
  assert(
    es
      .filter((e) => e.type === 'assistant.text.completed')
      .some((e) => e.payload.text.includes('?')),
    'Expected an open question',
  );
  await turn('20 minuti.');
  const result = await snapshot();
  assert.equal(result.mode, 'scheduled');
  assert.deepEqual(
    result.items.find((i) => i.id === fixedId),
    initial.items[0],
  );
  assert.deepEqual(
    result.items.find((i) => i.id === mechanic.id),
    mechanic,
  );
  const visit = result.items.find((i) => /sopralluogo|casa nuova/i.test(i.title));
  assert(visit);
  assert.equal(visit.slots.length, 1);
  assert.equal(localTime(visit.slots[0].startAt), '13:20');
  assert.equal(localTime(visit.slots[0].endAt), '13:50');
  assert(result.items.every((i) => i.slots.every((s) => s.reminderMinutes === null)));
  assert.equal((await api(`/v1/todo/lists?day=${day}`)).lists.length, 1, 'No duplicate day list');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM automations WHERE user_id=$1 AND enabled=true',
        [userId],
      )
    ).rows[0].n,
    0,
  );
  console.log(
    JSON.stringify({
      phase: 'open-question',
      waited: true,
      shortAnswerRecoveredOriginalPlan: true,
      noReminders: true,
      noDuplicateList: true,
    }),
  );
  console.log(
    JSON.stringify({
      costs: (
        await pool.query(
          'SELECT count(*)::int calls,sum(coalesce(cost_reported_usd,cost_estimated_usd,0))::float8 usd FROM llm_calls WHERE user_id=$1',
          [userId],
        )
      ).rows[0],
    }),
  );
  await writeFile('/tmp/ernie-todo-clarifications-events.json', JSON.stringify(events), {
    mode: 0o600,
  });
} catch (e) {
  await writeFile('/tmp/ernie-todo-clarifications-events.json', JSON.stringify(events), {
    mode: 0o600,
  });
  throw e;
} finally {
  if (active && ws?.readyState === WebSocket.OPEN) {
    send('user.cancel', { targetCorrelationId: active }, active);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.query(
    'UPDATE users SET settings=settings||\'{"killSwitch":true}\'::jsonb WHERE id=$1',
    [userId],
  );
  ws?.terminate();
  await new Promise((r) => setTimeout(r, 1000));
  for (const table of ['mastra_messages', 'mastra_threads'])
    await pool.query(`DELETE FROM ${table} WHERE "resourceId"=$1`, [userId]);
  await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  await rm(`${cfg.brain.dir}/${userId}`, { recursive: true, force: true });
  await rm(`${cfg.brain.dir}/.review/${userId}.json`, { force: true });
  const keys = await redis.keys(`ernie:sess:${sessionId}:*`);
  if (keys.length) await redis.del(...keys);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM users WHERE id=$1', [userId])).rows[0].n,
    0,
  );
  await redis.quit();
  await pool.end();
  console.log('Temporary account removed.');
}
