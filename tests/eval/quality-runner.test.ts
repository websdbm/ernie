import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkInvariant, evaluateTurn } from './quality-checks.js';
import { assertTestAccount, runQuality, validateSelection } from './quality-runner.js';
import type {
  AccountProof,
  FixtureDriver,
  QualityCorpus,
  QualityState,
  TurnEvidence,
} from './quality-types.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}

const corpus = JSON.parse(
  readFileSync(new URL('./quality-corpus.v1.json', import.meta.url), 'utf8'),
) as QualityCorpus;
const options = {
  runId: 'unit-run',
  apiKey: 'DO-NOT-LOG-KEY',
  wsUrl: 'ws://localhost:1234/ws',
  caseIds: ['reminder-one'],
  maxSpendUsd: 1,
};
const empty = (): QualityState => ({
  reminders: [],
  shopping: [],
  todos: [],
  brain: [],
  recipes: [],
});
const proof = (): AccountProof => ({
  userId: 'test-user',
  authenticatedUserId: 'test-user',
  testRunId: options.runId,
  markedTest: true,
  notificationsSuppressed: true,
  dangerousToolsDisabled: true,
  budgetCapUsd: 1,
  expiresAt: '2035-01-01T00:00:00Z',
});
const evidence = (): TurnEvidence => ({
  terminal: 'completed',
  firstResponseMs: 15,
  completedMs: 42,
  tools: [],
  blocks: [],
  text: 'Operazione completata',
  eventIds: [],
});
const persisted = (): QualityState => ({
  ...empty(),
  reminders: [
    { id: 'reminder1', text: 'ritirare il quaderno', at: '2031-11-20T17:00:00Z', eventAt: null },
  ],
});
function fixture() {
  const actions: string[] = [];
  let state = empty();
  const driver: FixtureDriver = {
    verify: vi.fn(async () => proof()),
    prepare: vi.fn(async () => {
      actions.push('prepare');
    }),
    snapshot: vi.fn(async () => structuredClone(state)),
    spentUsd: vi.fn(async () => 0),
    cleanup: vi.fn(async () => {
      actions.push('cleanup');
    }),
    close: vi.fn(async () => {
      actions.push('driver-close');
    }),
  };
  const turn = vi.fn(async () => {
    state = persisted();
    return evidence();
  });
  const socketClose = vi.fn(() => {
    actions.push('socket-close');
  });
  const connect = vi.fn(async () => ({ turn, close: socketClose }));
  return {
    driver,
    connect,
    turn,
    socketClose,
    actions,
    setState: (value: QualityState) => {
      state = value;
    },
  };
}

describe('bounded synthetic corpus', () => {
  it('ships 16 unique scenarios and future reminder dates, with no oversized turns', () => {
    expect(corpus.version).toBe('1.0.0');
    expect(corpus.cases).toHaveLength(16);
    expect(
      validateSelection(corpus, { ...options, caseIds: corpus.cases.map((c) => c.id) }),
    ).toHaveLength(16);
    for (const scenario of corpus.cases)
      for (const turn of scenario.turns)
        for (const check of turn.checks) {
          if (check.kind === 'reminder')
            expect(Date.parse(check.at)).toBeGreaterThan(Date.parse('2031-01-01'));
        }
  });
  it.each([0, -1, 1.01, NaN, Infinity])(
    'rejects unbounded/invalid spend %s before any connection',
    (maxSpendUsd) => {
      expect(() => validateSelection(corpus, { ...options, maxSpendUsd })).toThrow(
        'invalid_budget',
      );
    },
  );
  it('requires an explicit bounded sample and rejects a replay that changes the request', () => {
    expect(() => validateSelection(corpus, { ...options, caseIds: [] })).toThrow('invalid_sample');
    expect(() =>
      validateSelection(corpus, { ...options, caseIds: ['reminder-one', 'reminder-one'] }),
    ).toThrow('invalid_sample');
    const altered = structuredClone(corpus);
    required(required(altered.cases[0]).turns[0]).text = 'x'.repeat(601);
    expect(() => validateSelection(altered, options)).toThrow('invalid_prompt');
    required(required(altered.cases[0]).turns[0]).text = 'x';
    required(required(altered.cases[0]).turns[0]).replayPrevious = true;
    expect(() => validateSelection(altered, options)).toThrow('invalid_replay');
  });
  it.each(['markedTest', 'notificationsSuppressed', 'dangerousToolsDisabled'] as const)(
    'rejects false %s even with a valid connection',
    (key) => {
      expect(() =>
        assertTestAccount(
          { ...proof(), [key]: false } as unknown as AccountProof,
          options.runId,
          1,
        ),
      ).toThrow('unsafe_fixture');
    },
  );
  it('rejects identity mismatch, another run and expired proof', () => {
    for (const override of [
      { authenticatedUserId: 'real-user' },
      { testRunId: 'another-run' },
      { expiresAt: '2020-01-01' },
      { budgetCapUsd: 2 },
    ]) {
      expect(() => assertTestAccount({ ...proof(), ...override }, options.runId, 1)).toThrow(
        'unsafe_fixture',
      );
    }
  });
});

describe('runner state evidence, guardrails and cleanup', () => {
  it('passes only after verifying persisted state and closes the socket before cleanup', async () => {
    const f = fixture();
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.aborted).toBeNull();
    expect(result.accuracy).toMatchObject({ passedTurns: 1, failedTurns: 0 });
    expect(f.actions).toEqual(['prepare', 'socket-close', 'cleanup', 'driver-close']);
    expect(result.results[0]?.timings).toEqual({ firstResponseMs: 15, completedMs: 42 });
    expect(JSON.stringify(result)).not.toMatch(/DO-NOT-LOG-KEY|quaderno|test-user|Operazione/);
  });
  it('separates recovered tool failures from final state accuracy', async () => {
    const f = fixture();
    f.turn.mockImplementation(async () => {
      f.setState(persisted());
      return {
        ...evidence(),
        tools: [
          { callId: 'retry1', id: 'reminder_create', ok: false },
          { callId: 'retry2', id: 'reminder_create', ok: true },
        ],
      };
    });
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.accuracy.passedTurns).toBe(1);
    expect(result.execution).toEqual({ toolCalls: 2, failedToolCalls: 1, incompleteToolCalls: 0 });
  });
  it('does not accept successful transport and model confirmation without the database write', async () => {
    const f = fixture();
    f.turn.mockImplementation(async () => evidence());
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.accuracy.failedTurns).toBe(1);
    expect(result.results[0]?.checks.find((c) => c.id.startsWith('reminder:'))?.passed).toBe(false);
  });
  it('does not accept an empty completion even if persisted state is correct', async () => {
    const f = fixture();
    f.turn.mockImplementation(async () => {
      f.setState(persisted());
      return { ...evidence(), text: '', firstResponseMs: null };
    });
    expect((await runQuality(corpus, options, f.driver, f.connect)).accuracy.failedTurns).toBe(1);
  });
  it('rejects malformed snapshots rather than treating HTTP 200 as success', async () => {
    const f = fixture();
    vi.mocked(f.driver.snapshot).mockResolvedValue({ ok: true } as unknown as QualityState);
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.aborted).toBe('invalid_state');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.driver.cleanup).toHaveBeenCalled();
  });
  it('refuses a real account before preparing any fixture', async () => {
    const f = fixture();
    vi.mocked(f.driver.verify).mockResolvedValue({
      ...proof(),
      markedTest: false,
    } as unknown as AccountProof);
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.aborted).toBe('unsafe_fixture');
    expect(f.driver.prepare).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.driver.close).toHaveBeenCalled();
  });
  it('cleans even partially prepared cases and never leaks adapter exception text', async () => {
    const f = fixture();
    vi.mocked(f.driver.prepare).mockRejectedValue(
      new Error('postgres://SECRET-PASSWORD private-user-text'),
    );
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.aborted).toBe('prepare_failed');
    expect(f.actions).toEqual(['cleanup', 'driver-close']);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|postgres|private-user/);
  });
  it('still deletes fixtures when socket close throws and records unsuccessful cleanup', async () => {
    const f = fixture();
    f.socketClose.mockImplementation(() => {
      throw new Error('socket');
    });
    expect((await runQuality(corpus, options, f.driver, f.connect)).aborted).toBe(
      'socket_close_failed',
    );
    expect(f.driver.cleanup).toHaveBeenCalled();
    const g = fixture();
    vi.mocked(g.driver.cleanup).mockRejectedValue(new Error('database secret'));
    const result = await runQuality(corpus, options, g.driver, g.connect);
    expect(result.aborted).toBe('cleanup_failed');
    expect(result.cleanup).toEqual([{ caseId: 'reminder-one', ok: false }]);
    expect(g.driver.close).toHaveBeenCalled();
  });
  it('stops before the next paid turn once observed spending reaches the explicit threshold', async () => {
    const f = fixture();
    let spend = 0;
    vi.mocked(f.driver.spentUsd).mockImplementation(async () => spend);
    f.turn.mockImplementation(async () => {
      f.setState(persisted());
      spend = 1.02;
      return evidence();
    });
    const result = await runQuality(
      corpus,
      { ...options, caseIds: ['reminder-one', 'reminder-two-times'] },
      f.driver,
      f.connect,
    );
    expect(result.aborted).toBe('budget_reached');
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(result.budget.observedUsd).toBe(1.02);
    expect(result.fixtureClosed).toBe(true);
  });
  it('rejects a decreasing/invalid spend meter', async () => {
    const f = fixture();
    vi.mocked(f.driver.spentUsd).mockResolvedValueOnce(0.2).mockResolvedValue(0.1);
    const result = await runQuality(corpus, options, f.driver, f.connect);
    expect(result.aborted).toBe('invalid_spend');
    expect(f.turn).not.toHaveBeenCalled();
  });
  it('reuses the correlation for replay while still checking state after both turns', async () => {
    const f = fixture();
    const scenario = required(corpus.cases.find((c) => c.id === 'shopping-request-replay'));
    const before = { ...empty(), shopping: [{ id: 'list', name: 'Spesa', items: [] }] };
    f.setState(before);
    f.turn.mockImplementation(async () => {
      f.setState({
        ...empty(),
        shopping: [
          {
            id: 'list',
            name: 'Spesa',
            items: [{ id: 'item', name: 'cacao', quantity: null, checked: false }],
          },
        ],
      });
      return evidence();
    });
    const result = await runQuality(
      corpus,
      { ...options, caseIds: [scenario.id] },
      f.driver,
      f.connect,
    );
    expect(result.accuracy.passedTurns).toBe(2);
    const calls = f.turn.mock.calls as unknown as [string, string][];
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
    expect(f.driver.snapshot).toHaveBeenCalledTimes(3);
  });
});

describe('objective invariants catch known regressions', () => {
  it('distinguishes reminder firing time from appointment/deadline time', () => {
    const state = persisted();
    const check = {
      kind: 'reminder' as const,
      words: ['quaderno'],
      at: '2031-11-20T17:00:00Z',
      eventAt: '2031-11-20T18:00:00Z',
    };
    expect(checkInvariant(check, empty(), state, evidence())).toBe(false);
    required(state.reminders[0]).eventAt = check.eventAt;
    expect(checkInvariant(check, empty(), state, evidence())).toBe(true);
    state.reminders.push({ ...required(state.reminders[0]), id: 'duplicate' });
    expect(checkInvariant(check, empty(), state, evidence())).toBe(false);
  });
  it('requires an explicit list choice with pending intent, not merely unchanged data', () => {
    const check = { kind: 'shoppingChoice' as const, names: ['Spesa', 'Viaggio'] };
    expect(checkInvariant(check, empty(), empty(), evidence())).toBe(false);
    expect(
      checkInvariant(check, empty(), empty(), {
        ...evidence(),
        blocks: [
          {
            kind: 'shopping_lists',
            lists: [{ name: 'Spesa' }, { name: 'Viaggio' }],
            pendingText: 'aggiungi miele',
          },
        ],
      }),
    ).toBe(true);
  });
  it('detects recreated Todo IDs even when titles and statuses look correct', () => {
    const state: QualityState = {
      ...empty(),
      todos: [
        {
          id: 'todo',
          name: 'Preparativi',
          mode: 'simple',
          items: [{ id: 'a', title: 'Prenotare la sala', status: 'pending', slots: [] }],
        },
      ],
    };
    const after = structuredClone(state);
    required(required(after.todos[0]).items[0]).id = 'new-id';
    expect(
      checkInvariant(
        {
          kind: 'todo',
          name: 'Preparativi',
          items: [{ title: 'Prenotare la sala', status: 'pending' }],
          preserveIds: true,
        },
        state,
        after,
        evidence(),
      ),
    ).toBe(false);
  });
  it('fails duplicate cards and incomplete tool calls, independently from state', () => {
    const bad = {
      ...evidence(),
      blocks: [
        { kind: 'text', text: 'same' },
        { kind: 'text', text: 'same' },
      ],
      tools: [{ callId: '1', id: 'brain_write', ok: null }],
    };
    const checks = evaluateTurn([], empty(), empty(), bad);
    expect(checks.find((c) => c.id === 'cards-unique')?.passed).toBe(false);
    expect(checks.find((c) => c.id === 'tool-calls-completed')?.passed).toBe(false);
  });
});
