// Real-model regression, entirely in memory: no database, API account, notifications or user lists.
// RUN_TODO_MORNING_SMOKE=1 node --env-file-if-exists=.env --import tsx --conditions=development tests/manual/todo-morning-smoke.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { loadConfig } from '../../packages/config/src/index.ts';
import {
  buildProfiles,
  callCostUsd,
  createModelGateway,
  normalizeUsage,
} from '../../packages/model-gateway/src/index.ts';
import { TODO_PLANNING_FALLBACK } from '../../packages/skills/src/catalog.ts';
import { presentChoicesTool } from '../../packages/tools/src/builtins/present.ts';
import { getTimeTool } from '../../packages/tools/src/builtins/time.ts';
import { createTodoTools, validateTodoSnapshot } from '../../packages/tools/src/builtins/todo.ts';

assert.equal(
  process.env.RUN_TODO_MORNING_SMOKE,
  '1',
  'Explicit opt-in required: this uses real LLM credits',
);
const cfg = loadConfig({
  ...process.env,
  DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
  MIGRATIONS_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
  REDIS_URL: 'redis://127.0.0.1:1',
});
const gateway = createModelGateway({
  anthropicApiKey: cfg.providers.anthropicApiKey,
  openrouterApiKey: cfg.providers.openrouterApiKey,
  profiles: buildProfiles(cfg.llm.models),
});
const resolved = gateway.resolve('heavy', randomUUID());
const clock = '2026-11-01T06:30:00.000Z'; // Fixed synthetic 07:30 Europe/Rome, not the actual user's day.
const lists = new Map(),
  blocks = [],
  calls = [],
  steps = [];
const repo = {
  list: async () => [...lists.values()],
  get: async (_user, id) => lists.get(id) ?? null,
  save: async (_user, input) => {
    const snapshot = validateTodoSnapshot(
      input,
      [...lists.values()].filter((l) => l.id !== input.id),
    );
    const current = lists.get(input.id);
    assert.equal(input.revision, current?.revision);
    const list = { ...snapshot, revision: (current?.revision ?? 0) + 1, updatedAt: clock };
    lists.set(list.id, list);
    return list;
  },
};
const time = {
  ...getTimeTool,
  execute: async () => ({
    iso: clock,
    local: 'domenica 1 novembre 2026 alle ore 07:30',
    timezone: 'Europe/Rome',
  }),
};
const tools = Object.fromEntries(
  [time, presentChoicesTool, ...createTodoTools(repo, { canUse: async () => true })].map((spec) => [
    spec.id,
    createTool({
      id: spec.id,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      execute: async (input) => {
        calls.push(spec.id);
        const output = await spec.execute(spec.inputSchema.parse(input), {
          userId: 'synthetic',
          scopes: ['chat'],
        });
        const parsed = spec.outputSchema.parse(output);
        const card = spec.present?.(input, parsed);
        if (card) blocks.push(card);
        return parsed;
      },
    }),
  ]),
);
const agent = new Agent({
  id: 'todo-morning-regression',
  name: 'Ernie',
  model: resolved.model,
  tools,
  instructions:
    'Sei Ernie, un assistente personale. Rispondi in italiano, usa gli strumenti quando servono. Non dichiarare operazioni non eseguite.',
});
async function turn(messages) {
  const stream = await agent.stream(messages, {
    context: [
      {
        role: 'user',
        content: `[Contesto di questo turno, fornito dal sistema]\n${TODO_PLANNING_FALLBACK}`,
      },
    ],
    maxSteps: 6,
    modelSettings: { maxOutputTokens: 4096, maxRetries: 0 },
    abortSignal: AbortSignal.timeout(150000),
  });
  for await (const _ of stream.fullStream) {
    /* consume before reading complete output */
  }
  const output = await stream.getFullOutput();
  steps.push(...output.steps);
  assert.notEqual(output.finishReason, 'error');
  return output;
}
const original =
  "Ho tempo fino alle 8:30, quindi un'ora: vorrei pulire la cucina, leggere 10 pagine, lavarmi e verificare una cosa al computer. Mi fai un programmino veloce?";
const report = { model: resolved.profile.modelId, persistence: 'memory only', scenarios: [] };
try {
  const first = await turn([{ role: 'user', content: original }]);
  assert.equal(lists.size, 0, 'Unknown durations must be clarified before saving');
  assert.ok(
    blocks.some((b) => b.kind === 'choices') || first.text.includes('?'),
    'Ask an essential clarification',
  );
  report.scenarios.push({
    name: 'missing durations',
    clarified: true,
    saved: false,
    calls: [...calls],
  });
  calls.length = 0;
  blocks.length = 0;
  // Replay the already accepted proposal: avoids writing to the real account and reproduces the missing Ok transition.
  await turn([
    { role: 'user', content: original },
    {
      role: 'assistant',
      content:
        'Propongo: cucina 7:30–7:50, computer 7:50–8:00, lettura 8:00–8:15, lavarsi e prepararsi 8:15–8:30. Nessun avviso. Va bene?',
    },
    { role: 'user', content: 'Ok' },
  ]);
  assert.equal(lists.size, 1, 'Ok must produce one saved plan');
  const card = blocks.find((b) => b.kind === 'todo_list');
  assert.ok(card, 'Must emit a structured Todo card');
  assert.equal(card.list.mode, 'scheduled');
  assert.equal(card.list.day, '2026-11-01');
  const tasks = card.list.items.filter((i) => i.kind === 'task');
  assert.equal(tasks.length, 4);
  assert.equal(tasks.flatMap((i) => i.slots).length, 4);
  assert.ok(tasks.every((i) => i.slots.every((s) => s.reminderMinutes === null)));
  assert.ok(
    calls.includes('get_time') && calls.includes('todo_lists') && calls.includes('todo_save'),
  );
  report.scenarios.push({
    name: 'Ok after proposal',
    mode: card.list.mode,
    tasks: tasks.length,
    notifications: false,
    card: true,
    calls: [...calls],
  });
} finally {
  report.estimatedUsd = steps.reduce(
    (sum, step) =>
      sum +
      callCostUsd(normalizeUsage(step.usage, step.providerMetadata), resolved.profile.modelId),
    0,
  );
  await writeFile('/tmp/ernie-todo-morning-smoke.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
