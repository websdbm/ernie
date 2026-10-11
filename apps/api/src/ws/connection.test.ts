import { randomUUID } from 'node:crypto';
import type { TurnInput } from '@ernie/agent-core';
import { createLogger } from '@ernie/observability';
import {
  type AgentEvent,
  createEvent,
  decodeEvent,
  SequenceSource,
  shouldPersist,
} from '@ernie/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth.js';
import { SessionForbiddenError, type SessionRecord, type SessionStore } from '../sessions/store.js';
import { ClientConnection, type ConnectionDeps } from './connection.js';

const logger = createLogger({ level: 'silent', name: 't' });
const auth: AuthContext = {
  userId: randomUUID(),
  apiKeyId: randomUUID(),
  scopes: ['chat'],
  role: 'owner',
  companionName: 'Ernie',
  settings: {},
};

function fakeStore(owner = auth.userId) {
  const seqs = new Map<string, number>();
  const logs = new Map<string, AgentEvent[]>();
  const sessions = new Map<string, string>(); // id → userId
  const store: SessionStore = {
    async ensure(userId, _k, sessionId) {
      const existing = sessions.get(sessionId);
      if (existing && existing !== userId) throw new SessionForbiddenError('x');
      const resumed = existing !== undefined;
      sessions.set(sessionId, userId);
      const rec: SessionRecord = {
        id: sessionId,
        userId,
        contextTags: [],
        modelClass: 'standard',
        createdAt: new Date(),
        resumed,
      };
      return rec;
    },
    async touch() {},
    async nextSeq(id) {
      const n = seqs.get(id) ?? 0;
      seqs.set(id, n + 1);
      return n;
    },
    async currentSeq(id) {
      return (seqs.get(id) ?? 0) - 1;
    },
    async append(id, e) {
      if (!shouldPersist(e)) return;
      logs.set(id, [...(logs.get(id) ?? []), e]);
    },
    async replay(id, after) {
      return (logs.get(id) ?? []).filter((e) => e.seq > after);
    },
  };
  return { store, logs, sessions, owner };
}

function fakeSocket() {
  const sent: AgentEvent[] = [];
  return {
    sent,
    socket: { send: (d: string) => sent.push(decodeEvent(d)), close: vi.fn() },
    types: () => sent.map((e) => e.type),
    last: () => sent.at(-1) as AgentEvent,
  };
}

const companion = {
  agent: {},
  provider: 'openrouter',
  prefixFingerprint: 'fp',
  profile: {
    modelClass: 'standard',
    modelId: 'm',
    maxOutputTokens: 10,
    reasoning: 'none',
    maxSteps: 1,
  },
};

function deps(overrides: Partial<ConnectionDeps> = {}, storeImpl = fakeStore()): ConnectionDeps {
  return {
    logger,
    store: storeImpl.store,
    recorder: { record: vi.fn(async () => {}) },
    budget: { assertWithinBudget: vi.fn(async () => ({ spentUsd: 0 })) },
    dailyBudgetUsd: 2,
    getCompanion: vi.fn(async () => companion as never),
    runTurn: async (input: TurnInput) => {
      await input.emit('assistant.started', { route: 'llm' });
      await input.emit('assistant.text.delta', { delta: 'ciao ' });
      await input.emit('assistant.text.completed', { text: 'ciao ' });
      await input.emit('assistant.completed', { finishReason: 'stop' });
    },
    ...overrides,
  };
}

const client = (sessionId: string) => {
  const seq = new SequenceSource();
  return {
    start: (resumeFromSeq?: number) =>
      JSON.stringify(
        createEvent('session.start', resumeFromSeq === undefined ? {} : { resumeFromSeq }, {
          sessionId,
          correlationId: randomUUID(),
          seq: seq.next(),
        }),
      ),
    message: (text: string, correlationId = randomUUID()) =>
      JSON.stringify(
        createEvent('user.message', { text }, { sessionId, correlationId, seq: seq.next() }),
      ),
    cancel: (target: string) =>
      JSON.stringify(
        createEvent(
          'user.cancel',
          { targetCorrelationId: target },
          { sessionId, correlationId: randomUUID(), seq: seq.next() },
        ),
      ),
    ping: () =>
      JSON.stringify(
        createEvent(
          'session.ping',
          {},
          { sessionId, correlationId: randomUUID(), seq: seq.next() },
        ),
      ),
  };
};

const tick = () => new Promise((r) => setTimeout(r, 10));
const field = <T>(e: AgentEvent | undefined, key: string): T | undefined =>
  (e?.payload as Record<string, T> | undefined)?.[key];

describe('ClientConnection', () => {
  it('rifiuta messaggi prima di session.start e JSON non valido', async () => {
    const s = fakeSocket();
    const conn = new ClientConnection(s.socket, auth, deps());
    await conn.handleRaw('{not json');
    await conn.handleRaw(client(randomUUID()).message('ciao'));
    expect(s.types()).toEqual(['error', 'error']);
    expect(field<string>(s.sent[0], 'code')).toBe('invalid_json');
    expect(field<string>(s.sent[1], 'code')).toBe('no_session');
  });

  it('avvia la sessione, esegue un turno con seq crescenti e persiste gli eventi', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const conn = new ClientConnection(s.socket, auth, deps({}, st));
    await conn.handleRaw(c.start());
    expect(s.last().type).toBe('session.started');
    expect(s.last().seq).toBe(0);
    await conn.handleRaw(c.message('ciao'));
    await tick();
    expect(s.types()).toEqual([
      'session.started',
      'assistant.started',
      'assistant.text.delta',
      'assistant.text.completed',
      'assistant.completed',
    ]);
    expect(s.sent.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(st.logs.get(sessionId)?.length).toBe(5);
    await conn.close();
  });

  it('riprende la sessione e rinvia gli eventi mancanti', async () => {
    const st = fakeStore();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const first = fakeSocket();
    const conn1 = new ClientConnection(first.socket, auth, deps({}, st));
    await conn1.handleRaw(c.start());
    await conn1.handleRaw(c.message('ciao'));
    await tick();
    await conn1.close();

    const second = fakeSocket();
    const conn2 = new ClientConnection(second.socket, auth, deps({}, st));
    await conn2.handleRaw(c.start(1)); // il client ha visto fino a seq 1
    expect(second.sent[0]?.type).toBe('session.started');
    expect(field<number>(second.sent[0], 'replayed')).toBe(3);
    expect(second.sent.slice(1).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(second.sent[0]?.seq).toBe(5);
  });

  it('nega una sessione di un altro utente', async () => {
    const st = fakeStore();
    st.sessions.set('11111111-1111-4111-8111-111111111111', randomUUID());
    const s = fakeSocket();
    const conn = new ClientConnection(s.socket, auth, deps({}, st));
    await conn.handleRaw(client('11111111-1111-4111-8111-111111111111').start());
    expect((s.last().payload as { code: string }).code).toBe('session_forbidden');
  });

  it('ignora i duplicati, risponde ai ping senza persistere, segnala busy e budget', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          runTurn: async (input: TurnInput) => {
            await input.emit('assistant.started', { route: 'llm' });
            await gate;
            await input.emit('assistant.completed', {});
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    const ping = c.ping();
    await conn.handleRaw(ping);
    await conn.handleRaw(ping); // stesso id → ignorato
    expect(s.types().filter((t) => t === 'session.pong')).toHaveLength(1);
    expect(st.logs.get(sessionId)?.some((e) => e.type === 'session.pong')).toBe(false);

    await conn.handleRaw(c.message('uno'));
    await tick();
    await conn.handleRaw(c.message('due'));
    expect((s.last().payload as { code: string }).code).toBe('busy');
    release();
    await tick();
    expect(s.types().at(-1)).toBe('assistant.completed');

    const budgetDeps = deps(
      {
        budget: {
          assertWithinBudget: vi.fn(async () => {
            throw new (await import('@ernie/model-gateway')).BudgetExceededError(3, 2);
          }),
        },
      },
      st,
    );
    const conn2 = new ClientConnection(s.socket, auth, budgetDeps);
    await conn2.handleRaw(c.start());
    await conn2.handleRaw(c.message('tre'));
    await tick();
    expect((s.last().payload as { code: string }).code).toBe('budget_exceeded');
  });

  it('user.cancel abortisce il turno in corso', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          runTurn: async (input: TurnInput) => {
            await input.emit('assistant.started', { route: 'llm' });
            await new Promise<void>((resolve) =>
              input.abortSignal.addEventListener('abort', () => resolve()),
            );
            await input.emit('assistant.cancelled', { reason: 'user' });
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    const corr = randomUUID();
    await conn.handleRaw(c.message('lungo', corr));
    await tick();
    await conn.handleRaw(c.cancel(corr));
    await tick();
    expect(s.types().at(-1)).toBe('assistant.cancelled');
  });
});
