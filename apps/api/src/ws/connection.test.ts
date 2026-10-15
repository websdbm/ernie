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
    async raiseModelClass(_u, id, modelClass) {
      classes.set(id, modelClass);
      return modelClass;
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
  return { store, logs, sessions, owner, classes, tags: tags_, taints };
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
    await conn.handleRaw(
      c.message('ricordami alle 18 di chiamare Luca e anche di comprare il pane alle 19'),
    );
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

describe('ClientConnection: contesto dei tool e contaminazione di sessione', () => {
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
