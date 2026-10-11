import { randomUUID } from 'node:crypto';
import { createConversationMemory, createMastraStorage, runTurn } from '@ernie/agent-core';
import { createPool } from '@ernie/db';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import type { EventType, PayloadInputOf } from '@ernie/protocol';
import { createSoulRepository } from '@ernie/soul';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCompanionFactory } from './companion.js';

/**
 * Test online opzionale (costa frazioni di centesimo): due turni reali con la classe `light`
 * devono inviare lo stesso prefisso (system + model) byte per byte. Attivo solo con
 * OPENROUTER_API_KEY, DATABASE_URL/MIGRATIONS_DATABASE_URL e ERNIE_ONLINE_TESTS=1.
 */
const ready = Boolean(
  process.env.OPENROUTER_API_KEY &&
    process.env.DATABASE_URL &&
    process.env.ERNIE_ONLINE_TESTS === '1',
);

describe.skipIf(!ready)('prefisso stabile su due turni reali (online)', () => {
  const owner = createPool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL ?? (process.env.DATABASE_URL as string),
    max: 2,
  });
  const app = createPool({ connectionString: process.env.DATABASE_URL as string, max: 2 });
  const userId = randomUUID();
  const sessionId = randomUUID();
  const bodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO users (id, display_name, companion_name) VALUES ($1, 'online', 'Ernie')`,
      [userId],
    );
    await owner.query(`INSERT INTO sessions (id, user_id, model_class) VALUES ($1, $2, 'light')`, [
      sessionId,
      userId,
    ]);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('openrouter.ai') && typeof init?.body === 'string')
        bodies.push(JSON.parse(init.body));
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await owner.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await owner.end();
    await app.end();
  });

  it('system e modello identici tra i due turni; costo riportato dal provider', async () => {
    const logger = createLogger({ level: 'silent', name: 't' });
    const gateway = createModelGateway({
      openrouterApiKey: process.env.OPENROUTER_API_KEY as string,
      profiles: buildProfiles({
        light: 'anthropic/claude-haiku-5.5',
        standard: 'anthropic/claude-haiku-5.5',
        heavy: 'anthropic/claude-haiku-5.5',
      }),
    });
    const storage = createMastraStorage({
      connectionString: process.env.DATABASE_URL as string,
      disableInit: true,
      max: 2,
    });
    const memory = createConversationMemory(storage);
    const factory = createCompanionFactory({
      gateway,
      memory,
      souls: createSoulRepository(app),
      logger,
    });
    const auth = {
      userId,
      apiKeyId: randomUUID(),
      scopes: [],
      role: 'member' as const,
      companionName: 'Ernie',
      settings: {},
    };
    const session = {
      id: sessionId,
      userId,
      contextTags: [],
      modelClass: 'light' as const,
      createdAt: new Date(),
      resumed: false,
    };
    const companion = await factory.getCompanion(auth, session);
    expect(companion).not.toBeNull();
    const recorder = { record: vi.fn(async () => {}) };
    const emit = <T extends EventType>(_t: T, _p: PayloadInputOf<T>) => {};
    for (const text of ['Rispondi solo: ok', 'Rispondi solo: ok']) {
      await runTurn({
        userId,
        sessionId,
        correlationId: randomUUID(),
        text,
        inputMode: 'text',
        companion: companion as NonNullable<typeof companion>,
        abortSignal: new AbortController().signal,
        recorder,
        logger,
        emit,
      });
    }
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const sys = (b: Record<string, unknown>) =>
      JSON.stringify(
        (b.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system'),
      );
    expect(sys(bodies[0] as Record<string, unknown>)).toBe(
      sys(bodies[1] as Record<string, unknown>),
    );
    expect(bodies[0]?.model).toBe(bodies[1]?.model);
    expect(bodies[0]?.session_id).toBe(sessionId);
    const usageOpt = bodies[0]?.usage as { include?: boolean } | undefined;
    expect(usageOpt?.include).toBe(true);
    const calls = recorder.record.mock.calls as unknown as Array<
      [{ usage: { costReportedUsd?: number } }]
    >;
    expect(calls.length).toBe(2);
    const first = calls[0]?.[0];
    expect(first?.usage.costReportedUsd).toBeGreaterThan(0);
  });
});
