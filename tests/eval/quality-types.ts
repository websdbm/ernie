/** Fixture adapter is trusted local code; verify must read server/DB facts, never echo config. */
export interface AccountProof {
  userId: string;
  authenticatedUserId: string;
  testRunId: string;
  markedTest: true;
  notificationsSuppressed: true;
  dangerousToolsDisabled: true;
  budgetCapUsd: number;
  expiresAt: string;
}
export interface QualityState {
  reminders: Array<{ id: string; text: string; at: string; eventAt: string | null }>;
  shopping: Array<{
    id: string;
    name: string;
    items: Array<{ id: string; name: string; quantity: string | null; checked: boolean }>;
  }>;
  todos: Array<{
    id: string;
    name: string;
    mode: 'simple' | 'scheduled';
    items: Array<{ id: string; title: string; status: string; slots: unknown[] }>;
  }>;
  brain: Array<{ path: string; title: string; body: string }>;
  recipes: Array<{ id: string; title: string; ingredients: string[]; steps: string[] }>;
}
export interface FixtureSeed {
  shopping?: Array<{ name: string; items?: Array<{ name: string; quantity?: string }> }>;
  todos?: Array<{ name: string; items: Array<{ title: string; status: 'pending' | 'done' }> }>;
  brain?: Array<{ title: string; body: string }>;
  recipes?: Array<{ title: string; ingredients: string[]; steps: string[] }>;
}
export interface FixtureRef {
  caseId: string;
  sessionId: string;
}
export interface FixtureDriver {
  verify(): Promise<AccountProof>;
  /** Reset only this test user's owned fixtures; await ready projection/indexes before returning. */
  prepare(input: FixtureRef & { seed: FixtureSeed }): Promise<void>;
  /** Authoritative DB/API state, active records only; no model-generated summaries. */
  snapshot(input: FixtureRef): Promise<QualityState>;
  /** Cumulative recorded run cost; nondecreasing even after cleanup. Document unmetered services. */
  spentUsd(): Promise<number>;
  /** Stop/drain this case's jobs, then remove only its rows/files; idempotent even after failed prepare. */
  cleanup(input: FixtureRef): Promise<void>;
  /** Revoke test credentials/account; must also handle partially initialized fixtures. */
  close(): Promise<void>;
}
export interface FixtureConfig {
  runId: string;
  maxSpendUsd: number;
  apiKey: string;
  wsUrl: string;
}
export type CreateFixtureDriver = (config: FixtureConfig) => Promise<FixtureDriver>;

export type Check =
  | { kind: 'unchanged'; domains: Array<keyof QualityState> }
  | { kind: 'count'; domain: keyof QualityState; value: number }
  | { kind: 'reminder'; words: string[]; at: string; eventAt?: string }
  | {
      kind: 'shopping';
      list: string;
      items: Array<{ name: string; quantity?: string }>;
      exactCount: number;
    }
  | { kind: 'shoppingChoice'; names: string[] }
  | {
      kind: 'todo';
      name: string;
      items: Array<{ title: string; status: string }>;
      preserveIds?: boolean;
    }
  | { kind: 'brain'; title: string; contains: string[] }
  | {
      kind: 'recipe';
      title: string;
      ingredients: string[];
      ingredientCount: number;
      steps: string[];
    }
  | { kind: 'outputContains'; value: string }
  | { kind: 'block'; block: string; title?: string }
  | { kind: 'toolAny'; tools: string[] };
export interface QualityTurn {
  text: string;
  replayPrevious?: boolean;
  checks: Check[];
}
export interface QualityCase {
  id: string;
  area: string;
  seed: FixtureSeed;
  turns: QualityTurn[];
}
export interface QualityCorpus {
  version: string;
  cases: QualityCase[];
}
export interface TurnEvidence {
  terminal: 'completed' | 'error' | 'cancelled' | 'timeout' | 'disconnect';
  firstResponseMs: number | null;
  completedMs: number | null;
  tools: Array<{ callId: string; id: string; ok: boolean | null }>;
  blocks: Array<{ kind: string; [key: string]: unknown }>;
  text: string;
  eventIds: string[];
  errorCode?: string;
  busyRetries?: number;
}
export interface QualityTransport {
  turn(text: string, correlationId: string): Promise<TurnEvidence>;
  close(): void;
}
export type TransportFactory = (input: {
  wsUrl: string;
  apiKey: string;
  sessionId: string;
  timeoutMs: number;
}) => Promise<QualityTransport>;
