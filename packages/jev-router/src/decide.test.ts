import { describe, expect, it } from 'vitest';
import { createMemoryDecisionCache, decisionCacheKey, normalizeText } from './cache.js';
import { createMockJevClient } from './client.js';
import {
  buildQuestions,
  createDecisionRouter,
  fallbackDecision,
  mapAnswers,
  type RouterInput,
} from './decide.js';
import { DEFAULT_THRESHOLDS, JevResponse } from './schema.js';

const base: RouterInput = {
  text: 'Mi servono le cose per la carbonara',
  inputMode: 'voice',
  recentTurns: [],
  toolCategories: ['shopping_list', 'web_search'],
  skillCandidates: ['shopping_list'],
  sessionModelClass: 'standard',
};

/** Risposta reale osservata l'11 ott 2026 (smoke M3). */
const observed = JevResponse.parse({
  id: 'gen-1',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  usage: { input_tokens: 898, output_tokens: 194, cost: 3.7716e-5 },
  answers: {
    route: {
      type: 'choice',
      choice: 'skill',
      probabilities: { deterministic: 0.01, skill: 0.85, llm: 0.14 },
      confidence: 0.77,
    },
    model_class: {
      type: 'choice',
      choice: 'standard',
      probabilities: { standard: 1, heavy: 0 },
      confidence: 1,
    },
    deep_reasoning: { type: 'noul', noul: 0.47 },
    needs_memory: { type: 'noul', noul: 0.35 },
    tool_category: {
      type: 'choice',
      choice: 'shopping_list',
      probabilities: { none: 0, shopping_list: 1, web_search: 0 },
      confidence: 1,
    },
    skill_candidate: {
      type: 'choice',
      choice: 'shopping_list',
      probabilities: { none: 0, shopping_list: 1 },
      confidence: 1,
    },
    risk: { type: 'noul', noul: 0.91 },
  },
});

describe('buildQuestions', () => {
  it('include tool_category e skill_candidate solo con opzioni disponibili', () => {
    const q = buildQuestions(base);
    expect(Object.keys(q)).toEqual([
      'route',
      'model_class',
      'deep_reasoning',
      'needs_memory',
      'risk',
      'tool_category',
      'skill_candidate',
    ]);
    const bare = buildQuestions({ ...base, toolCategories: [], skillCandidates: [] });
    expect(Object.keys(bare)).toEqual([
      'route',
      'model_class',
      'deep_reasoning',
      'needs_memory',
      'risk',
    ]);
  });
});

describe('mapAnswers', () => {
  it('traduce la risposta osservata con le soglie predefinite', () => {
    const d = mapAnswers(observed, base, DEFAULT_THRESHOLDS, 836);
    expect(d.route).toBe('skill');
    expect(d.skillId).toBe('shopping_list');
    expect(d.toolCategories).toEqual(['shopping_list']);
    expect(d.modelClass).toBe('standard');
    expect(d.deepReasoning).toBe(false);
    expect(d.needsMemory).toBe(false);
    expect(d.riskSignal).toBe(0.91);
    expect(d.costUsd).toBeCloseTo(3.7716e-5);
    expect(d.inputTokens).toBe(898);
    expect(d.jevModel).toBe('typesafe/jev-1.13-20260917');
    expect(d.source).toBe('jev');
  });

  it('applica isteresi di classe e deep reasoning → heavy', () => {
    const heavySession = mapAnswers(
      observed,
      { ...base, sessionModelClass: 'heavy' },
      DEFAULT_THRESHOLDS,
      1,
    );
    expect(heavySession.modelClass).toBe('heavy');
    const deep = JevResponse.parse({
      ...observed,
      answers: { ...observed.answers, deep_reasoning: { type: 'noul', noul: 0.8 } },
    });
    expect(mapAnswers(deep, base, DEFAULT_THRESHOLDS, 1).modelClass).toBe('heavy');
  });

  it('sotto la confidenza di route ricade su llm; skill senza candidato valido → llm', () => {
    const low = JevResponse.parse({
      ...observed,
      answers: { ...observed.answers, route: { type: 'choice', choice: 'skill', confidence: 0.3 } },
    });
    expect(mapAnswers(low, base, DEFAULT_THRESHOLDS, 1).route).toBe('llm');
    const noSkill = mapAnswers(observed, { ...base, skillCandidates: [] }, DEFAULT_THRESHOLDS, 1);
    expect(noSkill.route).toBe('llm');
    expect(noSkill.skillId).toBeNull();
  });

  it('ignora categorie di tool non disponibili', () => {
    const d = mapAnswers(
      observed,
      { ...base, toolCategories: ['calendar'] },
      DEFAULT_THRESHOLDS,
      1,
    );
    expect(d.toolCategories).toEqual([]);
  });
});

describe('createDecisionRouter', () => {
  it('usa la cache esatta alla seconda richiesta identica (nessuna chiamata a Jev)', async () => {
    const client = createMockJevClient();
    const cache = createMemoryDecisionCache();
    const router = createDecisionRouter({ client, cache, cacheTtlSeconds: 60 });
    const a = await router.decide(base);
    const b = await router.decide({ ...base, text: '  mi servono le cose per la CARBONARA! ' });
    expect(a.source).toBe('jev');
    expect(b.source).toBe('cache');
    expect(client.calls).toBe(1);
    expect(normalizeText('  Ciao, Ernie!! ')).toBe('ciao ernie');
    expect(decisionCacheKey('a', 'x')).not.toBe(decisionCacheKey('a', 'y'));
  });

  it('timeout → fallback deterministico tracciato', async () => {
    const client = createMockJevClient(undefined, { latencyMs: 200 });
    const router = createDecisionRouter({ client, timeoutMs: 20 });
    const d = await router.decide(base);
    expect(d.source).toBe('fallback');
    expect(d.route).toBe('llm');
    expect(d.riskSignal).toBe(1);
    expect(d.needsMemory).toBe(true);
  });

  it('errore del client → fallback; nessun client → fallback', async () => {
    const failing = createMockJevClient(undefined, { failWith: new Error('boom') });
    expect((await createDecisionRouter({ client: failing }).decide(base)).source).toBe('fallback');
    expect((await createDecisionRouter({ client: null }).decide(base)).source).toBe('fallback');
    expect(fallbackDecision({ ...base, sessionModelClass: 'light' }, 0).modelClass).toBe(
      'standard',
    );
  });
});
