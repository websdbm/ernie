import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { evaluateTurn } from './quality-checks.js';
import type {
  AccountProof,
  FixtureDriver,
  QualityCase,
  QualityCorpus,
  QualityState,
  QualityTransport,
  TransportFactory,
} from './quality-types.js';

export interface RunOptions {
  runId: string;
  wsUrl: string;
  apiKey: string;
  caseIds: string[];
  maxSpendUsd: number;
  timeoutMs?: number;
}
export interface QualityReport {
  schemaVersion: 1;
  corpusVersion: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  budget: {
    limitUsd: number;
    observedUsd: number | null;
    enforcement: 'stop-new-turns-at-observed-limit';
    coverage: 'adapter-reported-costs-only';
  };
  results: Array<{
    caseId: string;
    turn: number;
    replay: boolean;
    passed: boolean;
    terminal: string;
    checks: Array<{ id: string; passed: boolean }>;
    timings: { firstResponseMs: number | null; completedMs: number | null };
    tools: Array<{ id: string; ok: boolean | null }>;
    busyRetries: number;
  }>;
  execution: { toolCalls: number; failedToolCalls: number; incompleteToolCalls: number };
  accuracy: {
    evaluatedTurns: number;
    passedTurns: number;
    failedTurns: number;
    scope: 'selected-synthetic-cases-only';
  };
  cleanup: Array<{ caseId: string; ok: boolean }>;
  fixtureClosed: boolean;
  aborted: string | null;
}
export function validateSelection(corpus: QualityCorpus, options: RunOptions): QualityCase[] {
  if (!Number.isFinite(options.maxSpendUsd) || options.maxSpendUsd <= 0 || options.maxSpendUsd > 1)
    throw new Error('invalid_budget');
  if (!options.runId || !options.apiKey || !/^wss?:\/\//.test(options.wsUrl))
    throw new Error('invalid_connection');
  if (
    !options.caseIds.length ||
    options.caseIds.length > 20 ||
    new Set(options.caseIds).size !== options.caseIds.length
  )
    throw new Error('invalid_sample');
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 90_000)
  )
    throw new Error('invalid_timeout');
  if (
    !Array.isArray(corpus.cases) ||
    corpus.cases.length > 20 ||
    new Set(corpus.cases.map((c) => c.id)).size !== corpus.cases.length
  )
    throw new Error('invalid_corpus');
  const selected = options.caseIds.map((id) => {
    const scenario = corpus.cases.find((c) => c.id === id);
    if (!scenario) throw new Error('unknown_case');
    if (!/^[a-z0-9-]{1,64}$/.test(id) || !scenario.turns.length || scenario.turns.length > 3)
      throw new Error('invalid_case');
    for (const [index, turn] of scenario.turns.entries()) {
      if (
        typeof turn.text !== 'string' ||
        !turn.text.trim() ||
        turn.text.length > 600 ||
        !turn.checks.length
      )
        throw new Error('invalid_prompt');
      if (turn.replayPrevious && (index === 0 || turn.text !== scenario.turns[index - 1]?.text))
        throw new Error('invalid_replay');
    }
    return scenario;
  });
  if (selected.reduce((n, c) => n + c.turns.length, 0) > 40) throw new Error('too_many_turns');
  return selected;
}
export function assertTestAccount(
  proof: AccountProof,
  runId: string,
  limit: number,
  now = Date.now(),
): void {
  if (
    proof?.markedTest !== true ||
    proof.notificationsSuppressed !== true ||
    proof.dangerousToolsDisabled !== true ||
    proof.testRunId !== runId ||
    !proof.userId ||
    proof.authenticatedUserId !== proof.userId ||
    !Number.isFinite(Date.parse(proof.expiresAt)) ||
    Date.parse(proof.expiresAt) <= now ||
    !Number.isFinite(proof.budgetCapUsd) ||
    proof.budgetCapUsd <= 0 ||
    proof.budgetCapUsd > limit
  )
    throw new Error('unsafe_fixture');
}
const text = z.string().max(100_000);
const id = z.string().min(1).max(512);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const stateSchema = z.object({
  reminders: z.array(z.object({ id, text, at: timestamp, eventAt: timestamp.nullable() })).max(500),
  shopping: z
    .array(
      z.object({
        id,
        name: text,
        items: z
          .array(z.object({ id, name: text, quantity: text.nullable(), checked: z.boolean() }))
          .max(500),
      }),
    )
    .max(500),
  todos: z
    .array(
      z.object({
        id,
        name: text,
        mode: z.enum(['simple', 'scheduled']),
        items: z
          .array(
            z.object({
              id,
              title: text,
              status: z.enum(['pending', 'done', 'cancelled']),
              slots: z.array(z.unknown()).max(100),
            }),
          )
          .max(500),
      }),
    )
    .max(500),
  brain: z.array(z.object({ path: id, title: text, body: text })).max(500),
  recipes: z
    .array(
      z.object({
        id,
        title: text,
        ingredients: z.array(text).max(100),
        steps: z.array(text).max(100),
      }),
    )
    .max(500),
});
function validateState(state: QualityState): QualityState {
  const result = stateSchema.safeParse(state);
  if (!result.success) throw new Error('invalid_state');
  return result.data;
}

export async function runQuality(
  corpus: QualityCorpus,
  options: RunOptions,
  driver: FixtureDriver,
  transportFactory: TransportFactory,
): Promise<QualityReport> {
  const report: QualityReport = {
    schemaVersion: 1,
    corpusVersion: corpus.version,
    runId: options.runId,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    budget: {
      limitUsd: options.maxSpendUsd,
      observedUsd: null,
      enforcement: 'stop-new-turns-at-observed-limit',
      coverage: 'adapter-reported-costs-only',
    },
    results: [],
    execution: { toolCalls: 0, failedToolCalls: 0, incompleteToolCalls: 0 },
    accuracy: {
      evaluatedTurns: 0,
      passedTurns: 0,
      failedTurns: 0,
      scope: 'selected-synthetic-cases-only',
    },
    cleanup: [],
    fixtureClosed: false,
    aborted: null,
  };
  let stage = 'configuration';
  let lastSpend = 0;
  const verify = async () => {
    assertTestAccount(await driver.verify(), options.runId, options.maxSpendUsd);
    const spend = await driver.spentUsd();
    if (!Number.isFinite(spend) || spend < lastSpend || spend < 0) throw new Error('invalid_spend');
    lastSpend = spend;
    report.budget.observedUsd = spend;
    if (spend >= options.maxSpendUsd) throw new Error('budget_reached');
  };
  try {
    const selected = validateSelection(corpus, options);
    stage = 'guard';
    await verify();
    for (const scenario of selected) {
      const ref = { caseId: scenario.id, sessionId: randomUUID() };
      let transport: QualityTransport | undefined;
      try {
        stage = 'guard';
        await verify();
        stage = 'prepare';
        await driver.prepare({ ...ref, seed: scenario.seed });
        stage = 'guard';
        await verify();
        stage = 'snapshot';
        let before = validateState(await driver.snapshot(ref));
        stage = 'websocket';
        transport = await transportFactory({
          wsUrl: options.wsUrl,
          apiKey: options.apiKey,
          sessionId: ref.sessionId,
          timeoutMs: options.timeoutMs ?? 60_000,
        });
        let correlationId = randomUUID();
        for (const [index, turn] of scenario.turns.entries()) {
          stage = 'guard';
          await verify();
          if (!turn.replayPrevious) correlationId = randomUUID();
          stage = 'turn';
          const evidence = await transport.turn(turn.text, correlationId);
          stage = 'snapshot';
          const after = validateState(await driver.snapshot(ref));
          stage = 'assertions';
          const checks = evaluateTurn(turn.checks, before, after, evidence);
          report.results.push({
            caseId: scenario.id,
            turn: index + 1,
            replay: Boolean(turn.replayPrevious),
            passed: checks.every((c) => c.passed),
            terminal: evidence.terminal,
            checks,
            timings: {
              firstResponseMs: evidence.firstResponseMs,
              completedMs: evidence.completedMs,
            },
            tools: evidence.tools.map((t) => ({ id: t.id, ok: t.ok })),
            busyRetries: evidence.busyRetries ?? 0,
          });
          before = after;
          stage = 'guard';
          await verify();
          if (evidence.errorCode === 'forbidden_tool') throw new Error('forbidden_tool');
          if (evidence.terminal !== 'completed') break;
        }
      } finally {
        // Stop incoming frames/turn before fixture deletion, even when snapshot/assertion failed.
        let socketClosed = true;
        try {
          transport?.close();
        } catch {
          socketClosed = false;
        }
        try {
          await driver.cleanup(ref);
          report.cleanup.push({ caseId: scenario.id, ok: true });
        } catch {
          report.cleanup.push({ caseId: scenario.id, ok: false });
          report.aborted = 'cleanup_failed';
        }
        if (!socketClosed) report.aborted ??= 'socket_close_failed';
      }
      if (report.aborted) throw new Error(report.aborted);
    }
  } catch (error) {
    const safe =
      error instanceof Error &&
      [
        'invalid_budget',
        'invalid_connection',
        'invalid_sample',
        'invalid_timeout',
        'invalid_corpus',
        'unknown_case',
        'invalid_case',
        'invalid_prompt',
        'invalid_replay',
        'too_many_turns',
        'unsafe_fixture',
        'invalid_state',
        'invalid_spend',
        'budget_reached',
        'cleanup_failed',
        'socket_close_failed',
        'forbidden_tool',
      ].includes(error.message)
        ? error.message
        : `${stage}_failed`;
    report.aborted ??= safe;
  } finally {
    try {
      const spent = await driver.spentUsd();
      if (Number.isFinite(spent) && spent >= lastSpend) {
        report.budget.observedUsd = spent;
        if (spent >= options.maxSpendUsd) report.aborted ??= 'budget_reached';
      } else report.aborted ??= 'invalid_spend';
    } catch {
      /* No sensitive provider/database error text in reports. */
    }
    try {
      await driver.close();
      report.fixtureClosed = true;
    } catch {
      report.aborted ??= 'fixture_close_failed';
    }
    report.finishedAt = new Date().toISOString();
    report.execution.toolCalls = report.results.reduce((total, row) => total + row.tools.length, 0);
    report.execution.failedToolCalls = report.results.reduce(
      (total, row) => total + row.tools.filter((tool) => tool.ok === false).length,
      0,
    );
    report.execution.incompleteToolCalls = report.results.reduce(
      (total, row) => total + row.tools.filter((tool) => tool.ok === null).length,
      0,
    );
    report.accuracy.evaluatedTurns = report.results.length;
    report.accuracy.passedTurns = report.results.filter((r) => r.passed).length;
    report.accuracy.failedTurns = report.results.filter((r) => !r.passed).length;
  }
  return report;
}
