import { randomUUID } from 'node:crypto';
import type { TurnInput } from '@ernie/agent-core';
import type { RouteDecision } from '@ernie/jev-router';
import { createLogger } from '@ernie/observability';
import {
  type AgentEvent,
  createEvent,
  decodeEvent,
  SequenceSource,
  shouldPersist,
} from '@ernie/protocol';
import {
  createRecipesSkill,
  createSecondBrainSkill,
  createSshSkill,
  SkillRegistry,
} from '@ernie/skills';
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
  const classes = new Map<string, 'standard' | 'heavy'>();
  const tags_ = new Map<string, string[]>();
  const taints = new Map<string, string>();
  const pins = new Set<string>();
  const requests = new Set<string>();
  const store: SessionStore = {
    async claimRequest(id, correlationId) {
      const key = `${id}:${correlationId}`;
      if (requests.has(key)) return false;
      requests.add(key);
      return true;
    },
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
    async raiseModelClass(_u, id, modelClass) {
      classes.set(id, modelClass);
      return modelClass;
    },
    async lowerModelClass(_u, id) {
      classes.set(id, 'standard');
      return 'standard';
    },
    async pinModelClass(id, pinned) {
      if (pinned) pins.add(id);
      else pins.delete(id);
    },
    async isModelClassPinned(id) {
      return pins.has(id);
    },
    async setContextTags(_u, id, tags) {
      tags_.set(id, [...tags]);
    },
    async markTainted(id, source) {
      taints.set(id, source);
    },
    async isTainted(id) {
      return taints.has(id);
    },
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
  return { store, logs, sessions, owner, classes, tags: tags_, taints, pins };
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

const fakeRouter = (decision: Partial<RouteDecision> = {}) => ({
  calls: 0,
  async decide(): Promise<RouteDecision> {
    this.calls++;
    return {
      route: 'llm',
      modelClass: 'standard',
      deepReasoning: false,
      needsMemory: true,
      toolCategories: [],
      skillId: null,
      riskSignal: 0.1,
      confidence: 0.9,
      source: 'jev',
      costUsd: 0.00004,
      inputTokens: 900,
      latencyMs: 5,
      ...decision,
    };
  },
});

function deps(
  overrides: Partial<ConnectionDeps> = {},
  storeImpl = fakeStore(),
  router = fakeRouter(),
): ConnectionDeps & {
  router: ReturnType<typeof fakeRouter>;
  decisions: { record: ReturnType<typeof vi.fn> };
} {
  const decisions = { record: vi.fn(async () => {}) };
  const base: ConnectionDeps = {
    logger,
    store: storeImpl.store,
    recorder: { record: vi.fn(async () => {}) },
    budget: { assertWithinBudget: vi.fn(async () => ({ spentUsd: 0 })) },
    dailyBudgetUsd: 2,
    getCompanion: vi.fn(async () => companion as never),
    invalidateCompanion: vi.fn(),
    router,
    decisions,
    runTurn: async (input: TurnInput) => {
      await input.emit('assistant.started', { route: 'llm' });
      await input.emit('assistant.text.delta', { delta: 'ciao ' });
      await input.emit('assistant.text.completed', { text: 'ciao ' });
      await input.emit('assistant.completed', { finishReason: 'stop' });
    },
  };
  const merged = { ...base } as ConnectionDeps;
  for (const [k, v] of Object.entries(overrides))
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  return Object.assign(merged, { router, decisions });
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
    message: (text: string, correlationId = randomUUID(), extra: Record<string, unknown> = {}) =>
      JSON.stringify(
        createEvent(
          'user.message',
          { text, ...extra },
          { sessionId, correlationId, seq: seq.next() },
        ),
      ),
    cancel: (target: string, spokenThroughIndex?: number) =>
      JSON.stringify(
        createEvent(
          'user.cancel',
          spokenThroughIndex === undefined
            ? { targetCorrelationId: target }
            : { targetCorrelationId: target, spokenThroughIndex },
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
  it('registra un campione numerico per richiesta, senza duplicarlo al replay', async () => {
    const recordPerformance = vi.fn();
    const socket = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const conn = new ClientConnection(socket.socket, auth, deps({ recordPerformance }));
    await conn.handleRaw(c.start());
    const requestId = randomUUID();
    await conn.handleRaw(c.message('Questo testo non deve entrare nelle metriche', requestId));
    await vi.waitFor(() => expect(recordPerformance).toHaveBeenCalledTimes(1));
    await conn.handleRaw(c.message('Questo testo non deve entrare nelle metriche', requestId));
    expect(recordPerformance).toHaveBeenCalledTimes(1);
    expect(recordPerformance.mock.calls[0]?.[1]).toMatchObject({
      sessionId,
      requestId,
      source: 'server',
      outcome: 'completed',
      inputMode: 'text',
    });
    expect(recordPerformance.mock.calls[0]?.[1].metrics.completedMs).toBeGreaterThanOrEqual(
      recordPerformance.mock.calls[0]?.[1].metrics.firstContentMs,
    );
    expect(JSON.stringify(recordPerformance.mock.calls)).not.toContain('Questo testo');
  });

  it('un guasto della telemetria non altera la risposta', async () => {
    const socket = fakeSocket();
    const c = client(randomUUID());
    const conn = new ClientConnection(
      socket.socket,
      auth,
      deps({
        recordPerformance: () => {
          throw new Error('storage non disponibile');
        },
      }),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('Ciao'));
    await vi.waitFor(() =>
      expect(socket.sent.some((e) => e.type === 'assistant.completed')).toBe(true),
    );
    expect(socket.sent.some((e) => e.type === 'assistant.completed')).toBe(true);
    expect(socket.sent.some((e) => e.type === 'error')).toBe(false);
  });

  it('reads a new video before selecting recipes, even when the router picked the cooking flow', async () => {
    const registry = new SkillRegistry()
      .register(createRecipesSkill())
      .register(createSecondBrainSkill());
    const router = fakeRouter({
      route: 'llm',
      modelClass: 'standard',
      skillId: 'ricette',
      riskSignal: 0,
    } as RouteDecision);
    const contexts: string[] = [];
    const s = fakeSocket();
    const c = client(randomUUID());
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          skills: { registryFor: async () => registry },
          runTurn: async (input: TurnInput) => {
            contexts.push(input.memoryContext ?? '');
            await input.emit('assistant.completed', { finishReason: 'stop' });
          },
        },
        fakeStore(),
        router,
      ),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('https://youtu.be/jNQXAC9IVRw'));
    await tick();
    expect(contexts[0]).toContain('youtube_read');
    expect(contexts[0]).toContain('Second Brain attivo');
    expect(contexts[0]).toContain('non culinario va riassunto');
    expect(contexts[0]).not.toContain('Procedura «Riconosce ricette');
    expect(contexts[0]).not.toContain('Procedura «Ricette»');
    await conn.close();
  });

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
    expect(second.sent.at(-1)?.type).toBe('session.started');
    expect(field<number>(second.sent.at(-1), 'replayed')).toBe(3);
    expect(second.sent.slice(0, -1).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(second.sent.at(-1)?.seq).toBe(5);
    // I vecchi handshake non devono riavviare il recupero iOS durante il replay.
    const before = second.sent.length;
    await conn2.handleRaw(c.start(0));
    expect(second.sent.slice(before).filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(second.sent.at(-1)?.type).toBe('session.started');
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

  it('user.cancel durante il routing impedisce di avviare il modello', async () => {
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const router = fakeRouter();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const decide = router.decide.bind(router);
    router.decide = async () => {
      entered();
      await gate;
      return decide();
    };
    const runTurn = vi.fn(async () => {});
    const conn = new ClientConnection(s.socket, auth, deps({ runTurn }, fakeStore(), router));
    await conn.handleRaw(c.start());
    const id = randomUUID();
    const handling = conn.handleRaw(c.message('parliamo di questa idea', id));
    await waiting;
    await conn.handleRaw(c.cancel(id));
    release();
    await handling;
    expect(runTurn).not.toHaveBeenCalled();
    expect(s.types()).toContain('assistant.cancelled');
    await conn.handleRaw(c.message('un’altra idea'));
    expect(runTurn).toHaveBeenCalledOnce();
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

  it('barge-in: il turno successivo sa fin dove l’utente ha sentito la risposta interrotta', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const contexts: Array<string | undefined> = [];
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          runTurn: async (input: TurnInput) => {
            contexts.push(input.memoryContext);
            await input.emit('assistant.started', { route: 'llm' });
            if (input.text === 'lungo') {
              await input.emit('assistant.text.delta', { delta: 'Ciao. Ecco tre ricette per te.' });
              await new Promise<void>((resolve) =>
                input.abortSignal.addEventListener('abort', () => resolve()),
              );
              await input.emit('assistant.cancelled', { reason: 'user' });
              return {
                text: 'Ciao. Ecco tre ricette per te.',
                cancelled: true,
                llmCalls: 1,
                toolCalls: 0,
                latencyMs: 1,
                costUsd: 0,
                loopDetected: false,
              };
            }
            await input.emit('assistant.text.completed', { text: 'ok' });
            await input.emit('assistant.completed', { finishReason: 'stop' });
            return {
              text: 'ok',
              cancelled: false,
              llmCalls: 1,
              toolCalls: 0,
              latencyMs: 1,
              costUsd: 0,
              loopDetected: false,
            };
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    const corr = randomUUID();
    await conn.handleRaw(c.message('lungo', corr));
    await tick();
    await conn.handleRaw(c.cancel(corr, 5));
    await tick();
    await conn.handleRaw(c.message('continua'));
    await tick();
    expect(contexts[0]).toBeUndefined();
    expect(contexts[1]).toContain('ha sentito solo: «Ciao.»');
    expect(contexts[1]).toContain('interrotto la tua risposta precedente');
    // La nota vale una volta sola.
    await conn.handleRaw(c.message('altro'));
    await tick();
    expect(contexts[2]).toBeUndefined();
  });
});

describe('ClientConnection: contesto del telefono (v1.10)', () => {
  it('chiarimento interno: messaggio ambiguo → riga «Ho inteso» in chat e nota nel contesto; chiaro → niente', async () => {
    const seen: Array<string | undefined> = [];
    const run = vi.fn(async (_ctx: unknown, input: { trigger: string; people: string[] }) => ({
      trigger: input.trigger as 'ambiguous',
      questions: [{ about: 'lui', question: 'Chi è «lui»?', options: ['Giorgio', 'Fabio'] }],
      answers: [{ about: 'lui', question: 'Chi è «lui»?', meaning: 'Giorgio', confidence: 0.9 }],
      resolved: [{ about: 'lui', meaning: 'Giorgio', confidence: 0.9 }],
      unresolved: [],
      costUsd: 0.0005,
      latencyMs: 300,
    }));
    const record = vi.fn(async () => {});
    const mk = (decision: Partial<RouteDecision>) => {
      const s = fakeSocket();
      const conn = new ClientConnection(
        s.socket,
        auth,
        deps(
          {
            clarify: {
              run: run as never,
              known: async () => ({ people: ['Giorgio', 'Fabio'], places: ['casa'] }),
              record,
              thresholds: { ambiguity: 0.6, correction: 0.6 },
            },
            runTurn: async (input: TurnInput) => {
              seen.push(input.memoryContext);
              await input.emit('assistant.started', { route: 'llm' });
              await input.emit('assistant.completed', { finishReason: 'stop' });
            },
          },
          fakeStore(),
          fakeRouter(decision),
        ),
      );
      return { s, conn, c: client(randomUUID()) };
    };
    const a = mk({ ambiguity: 0.85 });
    await a.conn.handleRaw(a.c.start());
    await a.conn.handleRaw(a.c.message('ricordagli di portarlo'));
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      trigger: 'ambiguous',
      people: ['Giorgio', 'Fabio'],
    });
    const line = a.s.sent.find((e) => e.type === 'assistant.block');
    expect(field<{ kind: string; items: unknown[] }>(line, 'block')).toEqual({
      kind: 'interpretation',
      trigger: 'ambiguous',
      items: [{ about: 'lui', meaning: 'Giorgio' }],
    });
    expect(seen[0]).toContain('«lui» = Giorgio');
    expect(record).toHaveBeenCalledTimes(1);

    // Messaggio chiaro: nessun chiarimento.
    const b = mk({ ambiguity: 0.1, correction: 0.05 });
    await b.conn.handleRaw(b.c.start());
    await b.conn.handleRaw(b.c.message('che ore sono?'));
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen[1] ?? '').not.toContain('Chiarimento');

    // Correzione esplicita: scatta anche se Jev non la segnala; se il chiarimento fallisce resta la nota.
    run.mockRejectedValueOnce(new Error('tempo scaduto'));
    const d = mk({ ambiguity: 0.1, correction: 0.1 });
    await d.conn.handleRaw(d.c.start());
    await d.conn.handleRaw(d.c.message('no, intendevo domani'));
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toMatchObject({ trigger: 'correction' });
    expect(seen[2]).toContain('L’utente sta correggendo');
  });

  it('ora locale e posizione arrivano al modello nel contesto del turno, non nel testo', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const c = client(randomUUID());
    const seen: Array<{ text: string; context?: string }> = [];
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          runTurn: async (input: TurnInput) => {
            seen.push({
              text: input.text,
              ...(input.memoryContext ? { context: input.memoryContext } : {}),
            });
            await input.emit('assistant.started', { route: 'llm' });
            await input.emit('assistant.text.completed', { text: 'ok' });
            await input.emit('assistant.completed', { finishReason: 'stop' });
            return {
              text: 'ok',
              cancelled: false,
              llmCalls: 1,
              toolCalls: 0,
              latencyMs: 1,
              costUsd: 0,
              loopDetected: false,
            };
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(
      c.message('che tempo fa qui?', randomUUID(), {
        device: {
          timezone: 'Europe/Rome',
          location: {
            latitude: 45.4064,
            longitude: 11.8768,
            accuracyM: 900,
            place: 'Padova, Veneto, Italia',
            at: new Date().toISOString(),
          },
        },
      }),
    );
    await tick();
    expect(seen[0]?.text).toBe('che tempo fa qui?');
    expect(seen[0]?.context).toContain(
      'Posizione attuale dal telefono: Padova, Veneto, Italia (45.41, 11.88',
    );
    expect(seen[0]?.context).toContain('fuso Europe/Rome');
    // Senza permesso il telefono non manda nulla: nessun blocco.
    await conn.handleRaw(c.message('ciao'));
    await tick();
    expect(seen[1]?.context ?? '').not.toContain('telefono');
  });
});

describe('ClientConnection: preparazione parallela e persistenza', () => {
  it('avvia le quattro letture indipendenti insieme e assembla in ordine con taint prima del modello', async () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const read = async <T>(name: string, value: T) => {
      started.push(name);
      await new Promise<void>((resolve) => release.set(name, resolve));
      return value;
    };
    const st = fakeStore();
    const socket = fakeSocket();
    const c = client(randomUUID());
    let context = '';
    let tainted = false;
    const marks: string[] = [];
    const conn = new ClientConnection(
      socket.socket,
      auth,
      deps(
        {
          brainSuggest: () =>
            read('brain', { path: 'test.md', title: 'BRAIN', passage: 'note', when: 'oggi' }),
          memories: {
            retrievalLimit: 3,
            afterTurn: async () => {},
            repo: {
              search: () =>
                read('retrieval', [
                  {
                    content: 'RETRIEVAL',
                    provenance: { trust: 0.1 },
                    createdAt: new Date(),
                    category: 'fact',
                  },
                ]),
              pendingNotices: () =>
                read('memoryNotices', [{ id: 'n', event: 'closed', oldText: 'MEMORY_NOTICE' }]),
              markNotified: async () => {
                marks.push('memory');
              },
            } as never,
          },
          profiles: {
            pendingNotices: () =>
              read('profileNotices', [
                { id: 'p', changes: [{ field: 'city', before: null, after: 'PROFILE_NOTICE' }] },
              ]),
            markNotified: async () => {
              marks.push('profile');
            },
          } as never,
          tools: {
            categories: [],
            setToolContext: (_s, ctx) => {
              if (ctx) tainted = ctx.run.tainted;
            },
          },
          runTurn: async (input) => {
            context = input.memoryContext ?? '';
            expect(tainted).toBe(true);
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    const pending = conn.handleRaw(c.message('parliamo di questa cosa insieme'));
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4));
      expect(context).toBe('');
      // Completamento inverso all'ordine di presentazione.
      for (const name of ['profileNotices', 'memoryNotices', 'retrieval', 'brain'])
        release.get(name)?.();
      await pending;
      await vi.waitFor(() => expect(context).toContain('PROFILE_NOTICE'));
      const positions = ['BRAIN', 'RETRIEVAL', 'MEMORY_NOTICE', 'PROFILE_NOTICE'].map((x) =>
        context.indexOf(x),
      );
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(marks).toEqual(['memory', 'profile']);
    } finally {
      for (const done of release.values()) done();
      await conn.close();
    }
  });

  it('non trasmette un evento prima che appendWithSeq abbia completato', async () => {
    const st = fakeStore();
    const socket = fakeSocket();
    const c = client(randomUUID());
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persisted: string[] = [];
    st.store.appendWithSeq = async (id, event) => {
      await gate;
      const stored = { ...event, seq: await st.store.nextSeq(id) };
      await st.store.append(id, stored);
      persisted.push(stored.id);
      return stored;
    };
    const conn = new ClientConnection(socket.socket, auth, deps({}, st));
    const pending = conn.handleRaw(c.start());
    await Promise.resolve();
    expect(socket.sent).toHaveLength(0);
    release();
    await pending;
    expect(socket.sent.length).toBeGreaterThan(0);
    expect(socket.sent.every((e) => persisted.includes(e.id))).toBe(true);
    await conn.close();
  });
});

describe('ClientConnection: suggerimenti del second brain (B2)', () => {
  it('una nota pertinente arriva nel contesto una volta sola per conversazione', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const c = client(randomUUID());
    const contexts: Array<string | undefined> = [];
    const excluded: string[][] = [];
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          brainSuggest: async (_u: string, _t: string, exclude: readonly string[]) => {
            excluded.push([...exclude]);
            return exclude.includes('Note/Caldaia.md')
              ? null
              : {
                  path: 'Note/Caldaia.md',
                  title: 'Caldaia',
                  when: '2026-03-02',
                  passage: 'Codice 4471.',
                };
          },
          runTurn: async (input: TurnInput) => {
            contexts.push(input.memoryContext);
            await input.emit('assistant.started', { route: 'llm' });
            await input.emit('assistant.text.completed', { text: 'ok' });
            await input.emit('assistant.completed', { finishReason: 'stop' });
            return {
              text: 'ok',
              cancelled: false,
              llmCalls: 1,
              toolCalls: 0,
              latencyMs: 1,
              costUsd: 0,
              loopDetected: false,
            };
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('domani viene il tecnico della caldaia'));
    await tick();
    await conn.handleRaw(c.message('e cosa gli devo dire della caldaia?'));
    await tick();
    await conn.handleRaw(c.message('ok'));
    await tick();
    expect(contexts[0]).toContain('«Caldaia» (2026-03-02): Codice 4471.');
    expect(contexts[1] ?? '').not.toContain('Caldaia');
    expect(excluded[1]).toEqual(['Note/Caldaia.md']);
    // Frasi brevi: nessuna ricerca.
    expect(excluded).toHaveLength(2);
  });
});

describe('ClientConnection: travaso proposto (B2)', () => {
  it('la proposta si valuta una volta per conversazione e arriva nel contesto', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const c = client(randomUUID());
    const contexts: Array<string | undefined> = [];
    let calls = 0;
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          brainTransfer: async () => {
            calls++;
            return 'Travaso proposto: 5 ricordi su «Giorgio».';
          },
          runTurn: async (input: TurnInput) => {
            contexts.push(input.memoryContext);
            await input.emit('assistant.started', { route: 'llm' });
            await input.emit('assistant.text.completed', { text: 'ok' });
            await input.emit('assistant.completed', { finishReason: 'stop' });
            return {
              text: 'ok',
              cancelled: false,
              llmCalls: 1,
              toolCalls: 0,
              latencyMs: 1,
              costUsd: 0,
              loopDetected: false,
            };
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('ciao, come va oggi?'));
    await tick();
    await conn.handleRaw(c.message('dimmi una cosa simpatica'));
    await tick();
    expect(calls).toBe(1);
    expect(contexts[0]).toContain('Travaso proposto');
    expect(contexts[1] ?? '').not.toContain('Travaso');
  });
});

describe('ClientConnection: Redis che non risponde', () => {
  it('se la numerazione degli eventi fallisce, handleRaw non rifiuta (l’API non deve cadere)', async () => {
    const st = fakeStore();
    st.store.nextSeq = async () => {
      throw new Error('Connection is closed.');
    };
    const s = fakeSocket();
    const c = client(randomUUID());
    const conn = new ClientConnection(s.socket, auth, deps({}, st));
    await expect(conn.handleRaw(c.start())).resolves.toBeUndefined();
    await expect(conn.handleRaw(c.ping())).resolves.toBeUndefined();
    await expect(conn.handleRaw('non è json')).resolves.toBeUndefined();
  });
});

describe('ClientConnection: domanda in sospeso di una skill', () => {
  it('«alle 9» dopo «a che ora?» crea il promemoria senza passare dal modello', async () => {
    const { SkillRegistry, createReminderSkill } = await import('@ernie/skills');
    const created: Array<{ text: string; at: Date }> = [];
    const store = {
      create: async (_u: string, r: { text: string; at: Date }) => {
        created.push(r);
        return { id: 'r1', text: r.text, at: r.at, status: 'scheduled' as const };
      },
      list: async () => [],
      remove: async () => false,
      update: async () => null,
    };
    const registry = new SkillRegistry();
    registry.register(createReminderSkill(store as never));
    const st = fakeStore();
    const s = fakeSocket();
    const c = client(randomUUID());
    let llmTurns = 0;
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps(
        {
          skills: { registryFor: async () => registry },
          runTurn: async (input: TurnInput) => {
            llmTurns++;
            await input.emit('assistant.started', { route: 'llm' });
            await input.emit('assistant.text.completed', { text: 'ok' });
            await input.emit('assistant.completed', { finishReason: 'stop' });
            return {
              text: 'ok',
              cancelled: false,
              llmCalls: 1,
              toolCalls: 0,
              latencyMs: 1,
              costUsd: 0,
              loopDetected: false,
            };
          },
        },
        st,
      ),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('ricordami di fatturare alla pizzeria'));
    await tick();
    await conn.handleRaw(c.message('Alle 9'));
    await tick();
    expect(created.map((r) => r.text)).toEqual(['fatturare alla pizzeria']);
    expect(llmTurns).toBe(0);
    // La domanda vale una volta sola: un altro orario ora va al percorso normale.
    await conn.handleRaw(c.message('Alle 10'));
    await tick();
    expect(created).toHaveLength(1);
  });
});

describe('ClientConnection: controllo dei comandi rapidi (Jev)', () => {
  it.each(['timeout', 'no_result'] as const)(
    'un controllo %s non autorizza una scrittura rapida: la richiesta passa al modello',
    async (failure) => {
      const { createReminderSkill } = await import('@ernie/skills');
      const create = vi.fn(async () => ({ id: 'r1', text: 'chiamare Luca', status: 'scheduled' }));
      const registry = new SkillRegistry().register(
        createReminderSkill({
          create,
          list: async () => [],
          remove: async () => false,
          update: async () => null,
        } as never),
      );
      const runTurn = vi.fn(async (input: TurnInput) => {
        expect(input.memoryContext).toContain('non è stato eseguito');
        await input.emit('assistant.started', { route: 'llm' });
        await input.emit('assistant.completed', { finishReason: 'stop' });
      });
      const s = fakeSocket();
      const c = client(randomUUID());
      const d = deps({
        skills: { registryFor: async () => registry },
        skillCheck: {
          threshold: 0.5,
          run: async () => {
            if (failure === 'timeout') throw new Error('This operation was aborted');
            return null;
          },
        },
        runTurn,
      });
      const conn = new ClientConnection(s.socket, auth, d);
      await conn.handleRaw(c.start());
      await conn.handleRaw(c.message('ricordami alle 18 di chiamare Luca'));
      await tick();
      expect(create).not.toHaveBeenCalled();
      expect(runTurn).toHaveBeenCalledOnce();
      expect(d.router.calls).toBe(1);
    },
  );

  it('due richieste nello stesso messaggio arrivano al modello anche senza Jev', async () => {
    const { createReminderSkill } = await import('@ernie/skills');
    const create = vi.fn();
    const registry = new SkillRegistry().register(
      createReminderSkill({
        create,
        list: async () => [],
        remove: async () => false,
        update: async () => null,
      }),
    );
    const runTurn = vi.fn(async (input: TurnInput) => {
      await input.emit('assistant.started', { route: 'llm' });
      await input.emit('assistant.completed', { finishReason: 'stop' });
    });
    const s = fakeSocket();
    const c = client(randomUUID());
    const d = deps({ skills: { registryFor: async () => registry }, runTurn });
    const conn = new ClientConnection(s.socket, auth, d);
    await conn.handleRaw(c.start());
    await conn.handleRaw(
      c.message(
        'Stasera ricordami di andare a comprare mocho e secchio e ritirare pacchi tutto alle 18:30\nRicordami inoltre entro le 19 di passare in casa nuova per verificare stato lavori',
      ),
    );
    await tick();
    expect(create).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(d.router.calls).toBe(1);
  });

  it('comando non fedele alla frase → niente comando rapido, decide il modello con la nota; fedele → si esegue', async () => {
    const { SkillRegistry, createReminderSkill } = await import('@ernie/skills');
    const created: Array<{ text: string }> = [];
    const store = {
      create: async (_u: string, r: { text: string; at: Date }) => {
        created.push(r);
        return { id: 'r1', text: r.text, at: r.at, status: 'scheduled' as const };
      },
      list: async () => [],
      remove: async () => false,
      update: async () => null,
    };
    const registry = new SkillRegistry();
    registry.register(createReminderSkill(store as never));
    const contexts: Array<string | undefined> = [];
    const checks: Array<{ planned: string }> = [];
    let faithful = 0.15;
    const record = vi.fn(async () => {});
    const s = fakeSocket();
    const c = client(randomUUID());
    const conn = new ClientConnection(
      s.socket,
      auth,
      deps({
        skills: { registryFor: async () => registry },
        skillCheck: {
          run: async (input) => {
            checks.push(input);
            return { faithful, costUsd: 0.00003, latencyMs: 400 };
          },
          threshold: 0.5,
          record,
        },
        runTurn: async (input: TurnInput) => {
          contexts.push(input.memoryContext);
          await input.emit('assistant.started', { route: 'llm' });
          await input.emit('assistant.completed', { finishReason: 'stop' });
        },
      }),
    );
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('ricordami alle 18 di chiamare Luca, è importante'));
    await tick();
    expect(checks[0]?.planned).toMatch(/^promemoria «.+» per l’utente /);
    expect(created).toHaveLength(0);
    expect(contexts[0]).toContain('Il comando rapido della funzione «ricordami» aveva capito');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'skill',
        skill: expect.objectContaining({ faithful: 0.15 }),
      }),
    );
    faithful = 0.92;
    await conn.handleRaw(c.message('ricordami alle 18 di chiamare Luca'));
    await tick();
    expect(created.map((r) => r.text)).toEqual(['chiamare Luca']);
    expect(contexts).toHaveLength(1);
  });
});

describe('ClientConnection: routing', () => {
  it('un comando è risolto senza Jev né modello e viene registrato come deterministico', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const c = client(randomUUID());
    const d = deps({}, st);
    const conn = new ClientConnection(s.socket, auth, d);
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('/aiuto'));
    await tick();
    expect(s.types()).toEqual([
      'session.started',
      'assistant.started',
      'assistant.text.completed',
      'assistant.completed',
    ]);
    expect(field<string>(s.sent[1], 'route')).toBe('deterministic');
    expect((field<{ llmCalls: number }>(s.sent[3], 'usage') ?? { llmCalls: -1 }).llmCalls).toBe(0);
    expect(d.router.calls).toBe(0);
    expect(d.decisions.record).toHaveBeenCalledTimes(1);
    expect((d.getCompanion as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("/classe heavy alza la classe della sessione e invalida l'agente", async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const d = deps({}, st);
    const conn = new ClientConnection(s.socket, auth, d);
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('/classe heavy'));
    await tick();
    expect(st.classes.get(sessionId)).toBe('heavy');
    expect(d.invalidateCompanion).toHaveBeenCalledWith(sessionId);
    await conn.handleRaw(c.message('/contesto cucina'));
    await tick();
    expect(st.tags.get(sessionId)).toEqual(['cucina']);
  });

  it.each(['Controlla il mio server SSH', 'example.it non risponde'])(
    'SSH attiva forza heavy e procedura per %s anche se il router propone standard',
    async (message) => {
      const st = fakeStore(),
        socket = fakeSocket(),
        sessionId = randomUUID(),
        c = client(sessionId);
      const registry = new SkillRegistry().register(createSshSkill());
      const seen: TurnInput[] = [];
      const d = deps(
        {
          getCompanion: async (_auth, session) =>
            ({
              ...companion,
              profile: { ...companion.profile, modelClass: session.modelClass },
            }) as never,
          skills: { registryFor: async () => registry },
          runTurn: async (input) => {
            seen.push(input);
            await input.emit('assistant.completed', {});
          },
        },
        st,
        fakeRouter({ modelClass: 'standard', requestedModelClass: 'standard' }),
      );
      const conn = new ClientConnection(socket.socket, auth, d);
      await conn.handleRaw(c.start());
      await conn.handleRaw(c.message(message));
      await tick();
      expect(st.classes.get(sessionId)).toBe('heavy');
      expect(seen[0]?.decision?.modelClass).toBe('heavy');
      expect(seen[0]?.memoryContext).toContain('ssh_investigate');
      expect(seen[0]?.memoryContext).toContain('present_choices');
      expect(d.invalidateCompanion).toHaveBeenCalledWith(sessionId);
    },
  );

  it('una decisione Jev heavy alza la classe prima del turno e passa la decisione a runTurn', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const seen: TurnInput[] = [];
    const d = deps(
      {
        runTurn: async (input: TurnInput) => {
          seen.push(input);
          await input.emit('assistant.completed', {});
        },
      },
      st,
      fakeRouter({ modelClass: 'heavy', deepReasoning: true }),
    );
    const conn = new ClientConnection(s.socket, auth, d);
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('pianifica il trasloco'));
    await tick();
    expect(d.router.calls).toBe(1);
    expect(st.classes.get(sessionId)).toBe('heavy');
    expect(seen[0]?.decision?.source).toBe('jev');
    expect(seen[0]?.decision?.inputTokens).toBe(900);
    expect(d.decisions.record).toHaveBeenCalledTimes(1);
  });
});

describe('ClientConnection: discesa della classe', () => {
  const HEAVY: Partial<RouteDecision> = {
    modelClass: 'heavy',
    deepReasoning: true,
    requestedModelClass: 'heavy',
  };
  const SIMPLE: Partial<RouteDecision> = { requestedModelClass: 'standard' };
  const UNSURE: Partial<RouteDecision> = {};
  // Come il router vero: dentro il turno la classe non scende sotto quella della sessione.
  const seqRouter = (steps: Partial<RouteDecision>[]) => {
    const base = fakeRouter();
    return Object.assign(base, {
      async decide(input: { sessionModelClass: string }): Promise<RouteDecision> {
        const step = steps[Math.min(base.calls, steps.length - 1)] ?? {};
        base.calls++;
        const heavy = step.modelClass === 'heavy' || input.sessionModelClass === 'heavy';
        return {
          ...(await fakeRouter(step).decide()),
          modelClass: heavy ? 'heavy' : 'standard',
        };
      },
    });
  };
  const run = async (steps: Partial<RouteDecision>[], first?: string) => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const classesSeen: string[] = [];
    const d = deps(
      {
        // La classe della sessione al momento del turno è quella che sceglie il modello dell'agente.
        getCompanion: vi.fn(async (_a, session) => {
          classesSeen.push(session.modelClass);
          return companion as never;
        }),
        runTurn: async (input: TurnInput) => {
          await input.emit('assistant.completed', {});
        },
      },
      st,
      seqRouter(steps),
    );
    const conn = new ClientConnection(s.socket, auth, d);
    await conn.handleRaw(c.start());
    if (first) {
      await conn.handleRaw(c.message(first));
      await tick();
    }
    for (let i = 0; i < steps.length; i++) {
      await conn.handleRaw(c.message(`domanda ${i}`));
      await tick();
    }
    return { st, sessionId, classesSeen, d };
  };

  it('alla seconda domanda semplice di fila la sessione torna standard e quella domanda risponde già standard', async () => {
    const { st, sessionId, classesSeen, d } = await run([HEAVY, SIMPLE, SIMPLE, SIMPLE]);
    expect(classesSeen).toEqual(['heavy', 'heavy', 'standard', 'standard']);
    expect(st.classes.get(sessionId)).toBe('standard');
    expect(d.invalidateCompanion).toHaveBeenCalledWith(sessionId);
    const recorded = d.decisions.record.mock.calls.map((c) => (c[3] as RouteDecision).modelClass);
    expect(recorded).toEqual(['heavy', 'heavy', 'standard', 'standard']);
  });

  it('una richiesta complessa in mezzo azzera il conto; le decisioni incerte non contano', async () => {
    const { st, sessionId, classesSeen } = await run([HEAVY, SIMPLE, HEAVY, SIMPLE, UNSURE]);
    expect(classesSeen).toEqual(['heavy', 'heavy', 'heavy', 'heavy', 'heavy']);
    expect(st.classes.get(sessionId)).toBe('heavy');
  });

  it('heavy scelto a mano con /classe heavy non scende; /classe standard lo riporta giù', async () => {
    const { st, sessionId, classesSeen } = await run([SIMPLE, SIMPLE, SIMPLE], '/classe heavy');
    expect(classesSeen).toEqual(['heavy', 'heavy', 'heavy']);
    expect(st.classes.get(sessionId)).toBe('heavy');
    expect(st.pins.has(sessionId)).toBe(true);
  });
});

describe('ClientConnection: contesto dei tool e contaminazione di sessione', () => {
  it.each(['suggestion', 'transfer'] as const)(
    'il contesto Brain %s conserva la provenienza non fidata',
    async (kind) => {
      const st = fakeStore();
      const s = fakeSocket();
      const sessionId = randomUUID();
      const c = client(sessionId);
      const contexts: Array<{ tainted: boolean; privateRead: boolean }> = [];
      const conn = new ClientConnection(
        s.socket,
        auth,
        deps(
          {
            ...(kind === 'suggestion'
              ? {
                  brainSuggest: async () => ({
                    path: 'note/test.md',
                    title: 'Importato',
                    when: '2026-10-17',
                    passage: 'Testo esterno',
                  }),
                }
              : { brainTransfer: async () => 'Testo di un documento importato' }),
            tools: {
              categories: [],
              setToolContext: (_id, ctx) => {
                if (ctx)
                  contexts.push({ tainted: ctx.run.tainted, privateRead: ctx.run.privateRead });
              },
            },
          },
          st,
        ),
      );
      await conn.handleRaw(c.start());
      await conn.handleRaw(c.message('vorrei parlare di una ricetta'));
      await tick();
      expect(contexts[0]).toEqual({ tainted: true, privateRead: true });
      expect(st.taints.get(sessionId)).toBe(`brain:${kind}`);
    },
  );

  it('imposta il contesto per il turno e, dopo contenuto non fidato, il turno successivo parte contaminato', async () => {
    const st = fakeStore();
    const s = fakeSocket();
    const sessionId = randomUUID();
    const c = client(sessionId);
    const contexts: Array<{ requestId: string; tainted: boolean } | null> = [];
    const d = deps(
      {
        runTurn: async (input: TurnInput) => {
          await input.emit('assistant.completed', {});
        },
      },
      st,
    );
    const conn = new ClientConnection(s.socket, auth, {
      ...d,
      tools: {
        categories: ['web'],
        setToolContext: (_id, ctx) => {
          contexts.push(ctx ? { requestId: ctx.requestId, tainted: ctx.run.tainted } : null);
          if (ctx && contexts.length === 1) ctx.onTainted?.('web_search:test'); // simula un tool che ingerisce contenuto esterno
        },
      },
    });
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('cerca una ricetta'));
    await tick();
    expect(contexts[0]?.tainted).toBe(false);
    expect(st.taints.get(sessionId)).toBe('web_search:test');
    await conn.handleRaw(c.message('aggiungi gli ingredienti'));
    await tick();
    const second = contexts.filter((x) => x !== null)[1];
    expect(second?.tainted).toBe(true);
    expect(contexts.filter((x) => x === null).length).toBeGreaterThanOrEqual(2);
  });
});

describe('ClientConnection: riconoscimento degli allegati', () => {
  async function setup(enabled = ['documenti', 'ricette']) {
    const { SkillRegistry, createDocumentsSkill, createRecipesSkill } = await import(
      '@ernie/skills'
    );
    const registry = new SkillRegistry();
    for (const skill of [createDocumentsSkill(), createRecipesSkill()])
      if (enabled.includes(skill.id)) registry.register(skill);
    const attached = vi.fn(async () => ({ text: 'Schema richiesto', blocks: [] }));
    const schemaByTitle = vi.fn(async () => ({ text: 'Schema richiesto', blocks: [] }));
    const runTurn = vi.fn(async (_input: TurnInput) => {});
    const clarify = vi.fn(async () => null);
    const d = deps(
      {
        skills: { registryFor: async () => registry },
        clarify: {
          run: clarify,
          known: async () => ({ people: [], places: [] }),
          thresholds: { ambiguity: 0.5, correction: 0.5 },
        },
        documents: {
          describe: async (_u, id) => ({ id, title: 'Foto', source: 'photo', pages: 1 }),
          flow: { attached, schemaByTitle },
        },
        runTurn,
      },
      undefined,
      fakeRouter({ skillId: 'documenti', ambiguity: 0.9 }),
    );
    const socket = fakeSocket();
    const conn = new ClientConnection(socket.socket, auth, d);
    const c = client(randomUUID());
    await conn.handleRaw(c.start());
    const id = randomUUID();
    const message = async (text: string, docId = id) => {
      await conn.handleRaw(
        c.message(text, randomUUID(), { attachments: [{ kind: 'document', id: docId }] }),
      );
      await tick();
    };
    return { attached, schemaByTitle, runTurn, message, id, socket, clarify };
  }

  it.each(['Leggi questo allegato.', 'Acquisisci questa ricetta', 'Salva questa ricetta'])(
    'legge %j con l’id attuale, senza imporre Documenti anche se Jev lo propone',
    async (text) => {
      const t = await setup();
      await t.message(text);
      expect(t.attached).not.toHaveBeenCalled();
      expect(t.clarify).not.toHaveBeenCalled();
      expect(t.runTurn).toHaveBeenCalledOnce();
      const input = t.runTurn.mock.calls[0]?.[0];
      expect(input?.text).toBe(text); // La cronologia conserva il messaggio originale.
      expect(input?.memoryContext).toContain(`id=${t.id}`);
      expect(input?.memoryContext).toContain('document_get');
      expect(input?.memoryContext).toContain('present_recipes');
      expect(input?.memoryContext).toContain('non autorizza recipe_save');
      expect(input?.memoryContext).not.toContain('Procedura «');
      const nextId = randomUUID();
      await t.message('Leggi questo allegato.', nextId);
      const next = t.runTurn.mock.calls[1]?.[0];
      expect(next?.memoryContext).toContain(`id=${nextId}`);
      expect(next?.memoryContext).not.toContain(t.id);
    },
  );

  it('mantiene il percorso di studio per la richiesta esplicita dei vecchi client', async () => {
    const t = await setup();
    await t.message('Riassumi questo documento per studiarlo e fammi lo schema.');
    expect(t.attached).toHaveBeenCalledWith(expect.anything(), t.id, {
      question: false,
      study: true,
    });
    expect(t.runTurn).not.toHaveBeenCalled();
  });

  it('Documenti spento non avvia lo schema mentre Ricette può leggere l’allegato', async () => {
    const t = await setup(['ricette']);
    await t.message('Fammi lo schema');
    expect(t.attached).not.toHaveBeenCalled();
    expect(t.runTurn).toHaveBeenCalledOnce();
    expect(t.runTurn.mock.calls[0]?.[0].memoryContext).toContain('present_recipes');
  });

  it('Ricette spento non introduce istruzioni per generare o salvare ricette', async () => {
    const t = await setup(['documenti']);
    await t.message('Acquisisci questa ricetta');
    expect(t.attached).not.toHaveBeenCalled();
    const context = t.runTurn.mock.calls[0]?.[0].memoryContext;
    expect(context).toContain('skill Ricette è disattivata');
    expect(context).not.toContain('present_recipes');
  });
});

describe('recupero delle richieste senza duplicare le azioni', () => {
  it('continua dopo il distacco, recupera il risultato e non ripete un invio con lo stesso id', async () => {
    const st = fakeStore();
    const first = fakeSocket();
    const second = fakeSocket();
    const c = client(randomUUID());
    const correlationId = randomUUID();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async (input: TurnInput) => {
      await input.emit('assistant.started', {});
      await input.emit('tool.started', { toolId: 'place_set', toolCallId: 'save' });
      await gate;
      expect(input.abortSignal.aborted).toBe(false);
      await input.emit('tool.completed', {
        toolId: 'place_set',
        toolCallId: 'save',
        ok: true,
        durationMs: 10,
      });
      await input.emit('assistant.text.completed', { text: 'Luogo salvato.' });
      await input.emit('assistant.completed', {});
    });
    const d = deps({ runTurn: run }, st);
    const conn = new ClientConnection(first.socket, auth, d);
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('Salva questa posizione', correlationId));
    await tick();
    const lastSeen = first.last().seq;
    expect(first.last().payload).toMatchObject({ displayName: 'Salvataggio del luogo' });
    conn.detach(first.socket);
    release();
    await tick();
    expect(first.last().seq).toBe(lastSeen);
    conn.attach(second.socket);
    expect(conn.detach(first.socket)).toBe(false); // close tardivo del vecchio socket
    await conn.handleRaw(c.start(lastSeen));
    expect(second.types()).toContain('assistant.completed');
    expect(second.last().type).toBe('session.started');
    await conn.handleRaw(c.message('Salva questa posizione', correlationId));
    expect(run).toHaveBeenCalledTimes(1);
    // Anche dopo un riavvio del processo, la prenotazione Redis impedisce una seconda esecuzione.
    const fresh = new ClientConnection(second.socket, auth, d);
    await fresh.handleRaw(c.start());
    await fresh.handleRaw(c.message('Salva questa posizione', correlationId));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('riprende un turno ancora attivo e Stop sulla nuova connessione lo annulla', async () => {
    const first = fakeSocket();
    const next = fakeSocket();
    const c = client(randomUUID());
    let input: TurnInput | undefined;
    const run = vi.fn(async (i: TurnInput) => {
      input = i;
      await i.emit('assistant.started', {});
      await new Promise<void>((resolve) =>
        i.abortSignal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await i.emit('assistant.cancelled', { reason: 'user' });
    });
    const conn = new ClientConnection(first.socket, auth, deps({ runTurn: run }));
    const corr = randomUUID();
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('Richiesta', corr));
    await tick();
    conn.detach(first.socket);
    conn.attach(next.socket);
    await conn.handleRaw(c.start(first.last().seq));
    await conn.handleRaw(c.message('Richiesta', corr));
    expect(next.last().type).toBe('session.pong');
    expect(run).toHaveBeenCalledTimes(1);
    await conn.handleRaw(c.cancel(corr));
    await tick();
    expect(input?.abortSignal.aborted).toBe(true);
    expect(next.types()).toContain('assistant.cancelled');
  });

  it('non riesegue una richiesta con esito sconosciuto dopo un arresto del server', async () => {
    const st = fakeStore();
    const sessionId = randomUUID();
    const corr = randomUUID();
    await st.store.claimRequest(sessionId, corr);
    const run = vi.fn();
    const socket = fakeSocket();
    const c = client(sessionId);
    const conn = new ClientConnection(socket.socket, auth, deps({ runTurn: run }, st));
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('Invia', corr));
    expect(run).not.toHaveBeenCalled();
    expect(socket.last().payload).toMatchObject({ code: 'request_interrupted', retryable: false });
  });
});

it('WebSocket reale: riconnessione durante un salvataggio senza duplicarlo', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerWs } = await import('./plugin.js');
  const app = Fastify();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (input: TurnInput) => {
    await input.emit('assistant.started', {});
    await gate;
    expect(input.abortSignal.aborted).toBe(false);
    await input.emit('assistant.text.completed', { text: 'Salvato una volta' });
    await input.emit('assistant.completed', {});
  });
  await registerWs(app, {
    authenticator: { authenticate: async () => auth },
    allowedOrigins: [],
    connection: deps({ runTurn: run }),
  });
  await app.ready();
  const c = client(randomUUID());
  const corr = randomUUID();
  const first = await app.injectWS('/v1/ws');
  const events: AgentEvent[] = [];
  first.on('message', (data: Buffer) => events.push(decodeEvent(data.toString())));
  try {
    first.send(c.start());
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('session.started'));
    first.send(c.message('Salva questa posizione', corr));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('assistant.started'));
    const lastSeq = events.at(-1)?.seq ?? -1;
    await new Promise<void>((resolve) => {
      first.once('close', () => resolve());
      first.terminate();
    });
    const second = await app.injectWS('/v1/ws');
    const resumed: AgentEvent[] = [];
    second.on('message', (data: Buffer) => resumed.push(decodeEvent(data.toString())));
    second.send(c.start(lastSeq));
    await vi.waitFor(() => expect(resumed.at(-1)?.type).toBe('session.started'));
    second.send(c.message('Salva questa posizione', corr));
    await vi.waitFor(() => expect(resumed.at(-1)?.type).toBe('session.pong'));
    release();
    await vi.waitFor(() =>
      expect(resumed.some((e) => e.type === 'assistant.completed')).toBe(true),
    );
    expect(run).toHaveBeenCalledTimes(1);
    second.terminate();
  } finally {
    release();
    first.terminate();
    await app.close();
  }
});

describe('live authorization during an existing session', () => {
  it('blocks new messages when the kill switch changes without reconnecting', async () => {
    const d = deps({ refreshAuth: async () => ({ ...auth, settings: { killSwitch: true } }) });
    const s = fakeSocket(),
      c = client(randomUUID());
    const conn = new ClientConnection(s.socket, auth, d);
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('aggiungi latte alla lista'));
    expect(s.last()).toMatchObject({ type: 'error', payload: { code: 'disabled' } });
    expect(d.router.calls).toBe(0);
    expect(d.getCompanion).not.toHaveBeenCalled();
  });
  it('rejects a revoked key and reads the updated budget instead of the handshake snapshot', async () => {
    const revoked = deps({ refreshAuth: async () => null });
    const s = fakeSocket(),
      c = client(randomUUID());
    const conn = new ClientConnection(s.socket, auth, revoked);
    await conn.handleRaw(c.start());
    await conn.handleRaw(c.message('ciao'));
    expect(s.last()).toMatchObject({ type: 'error', payload: { code: 'unauthorized' } });
    expect(s.socket.close).toHaveBeenCalledWith(1008, 'unauthorized');
    expect(revoked.router.calls).toBe(0);

    const fresh = deps({
      dailyBudgetUsd: 0,
      refreshAuth: async () => ({ ...auth, role: 'member', settings: { dailyBudgetUsd: 0.1 } }),
    });
    const s2 = fakeSocket(),
      c2 = client(randomUUID());
    const conn2 = new ClientConnection(s2.socket, auth, fresh);
    await conn2.handleRaw(c2.start());
    await conn2.handleRaw(c2.message('ciao'));
    expect(fresh.budget.assertWithinBudget).toHaveBeenCalledWith(auth.userId, 0.1);
  });
});

describe('continuity and grounded tool user input', () => {
  it.each([false, true])(
    'fresh context is private, derived hints tainted=%s; original input reaches tools',
    async (untrusted) => {
      const st = fakeStore(),
        socket = fakeSocket(),
        sessionId = randomUUID(),
        c = client(sessionId);
      const contexts: Array<{
        userMessage: string | undefined;
        privateRead: boolean;
        tainted: boolean;
      }> = [];
      const seen: Array<string | undefined> = [];
      const conn = new ClientConnection(
        socket.socket,
        auth,
        deps(
          {
            continuity: async (userId, actualSession, text) => {
              expect(userId).toBe(auth.userId);
              expect(actualSession).toBe(sessionId);
              expect(text).toBe('Preferisco risposte brevi');
              return { text: 'Preferenza esplicita aggiornata', untrusted };
            },
            tools: {
              categories: [],
              setToolContext: (_, ctx) => {
                if (ctx)
                  contexts.push({
                    userMessage: ctx.userMessage,
                    privateRead: ctx.run.privateRead,
                    tainted: ctx.run.tainted,
                  });
              },
            },
            runTurn: async (input) => {
              seen.push(input.memoryContext);
              await input.emit('assistant.completed', {});
            },
          },
          st,
        ),
      );
      await conn.handleRaw(c.start());
      await conn.handleRaw(c.message('Preferisco risposte brevi'));
      await tick();
      expect(seen[0]).toContain('Preferenza esplicita aggiornata');
      expect(contexts[0]).toEqual({
        userMessage: 'Preferisco risposte brevi',
        privateRead: true,
        tainted: untrusted,
      });
    },
  );
});
