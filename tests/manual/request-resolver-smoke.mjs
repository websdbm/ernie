// Opt-in, real Jev + light LLM; no DB, account mutations, tools or notifications.
// RUN_REQUEST_RESOLVER_SMOKE=1 node --env-file-if-exists=.env --import tsx --conditions=development tests/manual/request-resolver-smoke.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClarifyQuestioner } from '../../packages/agent-core/src/clarify.ts';
import { loadConfig } from '../../packages/config/src/index.ts';
import {
  createClarifier,
  REQUEST_RESOLUTION_ACTIVATION,
} from '../../packages/jev-router/src/clarify.ts';
import { createHttpJevClient } from '../../packages/jev-router/src/client.ts';
import { createDecisionRouter } from '../../packages/jev-router/src/decide.ts';
import { buildProfiles, createModelGateway } from '../../packages/model-gateway/src/index.ts';
import { SKILL_CATALOG } from '../../packages/skills/src/catalog.ts';

assert.equal(
  process.env.RUN_REQUEST_RESOLVER_SMOKE,
  '1',
  'Real model credits require explicit opt-in',
);
const cfg = loadConfig({
  ...process.env,
  DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
  REDIS_URL: 'redis://127.0.0.1:1',
});
assert.ok(cfg.providers.openrouterApiKey, 'Jev must be configured');
const jev = createHttpJevClient({
  apiKey: cfg.providers.openrouterApiKey,
  model: cfg.router.jevModel,
});
const router = createDecisionRouter({ client: jev, timeoutMs: cfg.router.timeoutMs });
const capabilities = SKILL_CATALOG.filter((s) => s.defaultEnabled || s.id === 'ssh').map((s) => ({
  id: s.id,
  description: s.description.slice(0, 300),
}));
const cases = [
  {
    id: 'informal-day-plan',
    positive: true,
    text: 'Ho un’ora per pulire la cucina, leggere, lavarmi e controllare una cosa al computer. Mi fai un programmino veloce?',
  },
  {
    id: 'soft-request',
    positive: true,
    text: 'Mi servirebbe una scaletta di quello che devo fare stamattina',
  },
  {
    id: 'shopping',
    positive: true,
    text: 'Mi manca il miele: aggiungilo alla lista della spesa che uso già',
  },
  {
    id: 'reminder',
    positive: true,
    text: 'Domani alle nove devo chiamare il dentista, me lo ricordi?',
  },
  {
    id: 'confirmation',
    positive: true,
    text: 'Ok',
    recent: [
      'utente: fammi un programma per stamattina',
      'assistente: Propongo cucina 20 minuti, lettura 15, computer 10, prepararsi 15. Salvo questa timeline?',
    ],
  },
  { id: 'greeting', positive: false, text: 'Ciao, buongiorno!' },
  { id: 'thanks', positive: false, text: 'Grazie mille' },
  { id: 'general-question', positive: false, text: 'Perché il cielo è azzurro?' },
  {
    id: 'hypothesis',
    positive: false,
    text: 'In generale quali sono i vantaggi di organizzare una giornata? Non creare niente.',
  },
];
const report = {
  threshold: REQUEST_RESOLUTION_ACTIVATION,
  capabilities: capabilities.length,
  rows: [],
  actionsExecuted: 0,
  costUsd: 0,
};
try {
  for (const c of cases) {
    const d = await router.decide({
      text: c.text,
      inputMode: 'text',
      recentTurns: c.recent ?? [],
      toolCategories: ['todo', 'reminders', 'shopping_list', 'brain'],
      skillCandidates: ['ricordami'],
      capabilities,
      sessionModelClass: 'standard',
    });
    report.costUsd += d.costUsd;
    report.rows.push({
      id: c.id,
      expectedOperational: c.positive,
      detected: (d.operationalIntent ?? 0) >= REQUEST_RESOLUTION_ACTIVATION,
      score: d.operationalIntent,
      skill: d.skillId,
      source: d.source,
      latencyMs: d.latencyMs,
    });
  }
  const positives = report.rows.filter((r) => r.expectedOperational);
  report.detectedRequests = positives.filter((r) => r.detected).length;
  report.falsePositives = report.rows.filter((r) => !r.expectedOperational && r.detected).length;
  assert.equal(report.detectedRequests, positives.length, 'A required operation was missed');
  assert.ok(
    report.rows.every((r) => r.source === 'jev'),
    'Fallback cannot be presented as real Jev validation',
  );
  const gateway = createModelGateway({
    anthropicApiKey: cfg.providers.anthropicApiKey,
    openrouterApiKey: cfg.providers.openrouterApiKey,
    profiles: buildProfiles(cfg.llm.models),
  });
  const modelQuestioner = createClarifyQuestioner(
    { gateway, recorder: { record: async () => {} } },
    { userId: 'synthetic-resolver', sessionId: randomUUID(), requestId: randomUUID() },
  );
  let questionCost = 0;
  const questioner = async (input, options) => {
    const result = await modelQuestioner(input, options);
    questionCost = result.costUsd;
    report.generatedQuestions = result.questions;
    return result;
  };
  const clarified = await createClarifier({
    jev,
    questioner,
    minConfidence: 0.8,
    timeoutMs: 7000,
  }).clarify({
    trigger: 'request',
    message: cases[0].text,
    inputMode: 'text',
    recentTurns: [],
    people: [],
    places: [],
    capabilities,
  });
  report.costUsd += clarified?.costUsd ?? questionCost;
  report.resolution = {
    capability: clarified?.capabilityId,
    unresolved: clarified?.unresolved.length,
    latencyMs: clarified?.latencyMs,
  };
  assert.equal(clarified?.capabilityId, 'todo', 'The real LLM → Jev resolver must recover Todo');
} finally {
  await writeFile('/tmp/ernie-request-resolver-smoke.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
