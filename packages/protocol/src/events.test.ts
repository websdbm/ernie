import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentEventSchema,
  createEvent,
  decodeEvent,
  EVENT_AUDIENCE,
  EVENT_DIRECTION,
  EVENT_TYPES,
  encodeEvent,
  isUserVisible,
  PROTOCOL_VERSION,
  parseClientEvent,
  safeParseEvent,
  shouldPersist,
} from './events.js';

const ctx = { sessionId: randomUUID(), correlationId: randomUUID(), seq: 0 };

describe('createEvent', () => {
  it('costruisce un envelope completo e valido', () => {
    const e = createEvent('user.message', { text: 'ciao' }, ctx);
    expect(e.v).toBe(PROTOCOL_VERSION);
    expect(e.type).toBe('user.message');
    expect(e.payload.text).toBe('ciao');
    expect(e.payload.inputMode).toBe('text');
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(e.ts).toISOString()).not.toThrow();
    expect(e.sessionId).toBe(ctx.sessionId);
    expect(e.correlationId).toBe(ctx.correlationId);
    expect(e.seq).toBe(0);
  });

  it('rifiuta payload non conformi', () => {
    expect(() => createEvent('user.message', { text: '' }, ctx)).toThrow();
    expect(() =>
      createEvent(
        'assistant.completed',
        // @ts-expect-error: usage incompleto
        { usage: { inputTokens: 1 } },
        ctx,
      ),
    ).toThrow();
  });

  it('round-trip encode/decode', () => {
    const e = createEvent('assistant.text.delta', { delta: 'par' }, { ...ctx, seq: 7 });
    const decoded = decodeEvent(encodeEvent(e));
    expect(decoded).toEqual(e);
  });
});

describe('schemi', () => {
  it('ogni tipo di evento ha direzione e audience definiti', () => {
    const typesInSchema = AgentEventSchema.options.map((o) => o.shape.type.value);
    expect(new Set(typesInSchema)).toEqual(new Set(EVENT_TYPES));
    for (const t of EVENT_TYPES) {
      expect(EVENT_DIRECTION[t]).toBeDefined();
      expect(EVENT_AUDIENCE[t]).toBeDefined();
    }
  });

  it('distingue eventi mostrabili da eventi del runtime', () => {
    expect(isUserVisible({ type: 'assistant.text.delta' })).toBe(true);
    expect(isUserVisible({ type: 'tool.started' })).toBe(false);
    expect(isUserVisible({ type: 'error' })).toBe(true);
  });

  it('parseClientEvent accetta solo eventi client→server', () => {
    const ok = createEvent('session.start', { clientInfo: { platform: 'ios' } }, ctx);
    expect(parseClientEvent(ok).type).toBe('session.start');
    const serverOnly = createEvent('assistant.started', {}, ctx);
    expect(() => parseClientEvent(serverOnly)).toThrow();
  });

  it('rifiuta versioni di protocollo sconosciute', () => {
    const e = createEvent('session.ping', {}, ctx);
    const res = safeParseEvent({ ...e, v: 2 });
    expect(res.success).toBe(false);
  });
});

describe('v1.1', () => {
  it("cancel accetta spokenThroughIndex e persist viaggia nell'envelope", () => {
    const e = createEvent(
      'user.cancel',
      { targetCorrelationId: ctx.correlationId, spokenThroughIndex: 42 },
      { ...ctx, persist: false },
    );
    expect(e.payload.spokenThroughIndex).toBe(42);
    expect(e.persist).toBe(false);
    expect(shouldPersist(e)).toBe(false);
    expect(shouldPersist(createEvent('session.ping', {}, ctx))).toBe(false);
    expect(shouldPersist(createEvent('assistant.text.delta', { delta: 'x' }, ctx))).toBe(true);
  });

  it('eventi avatar con vocabolario chiuso', () => {
    const ok = createEvent('avatar.emotion', { name: 'happy', charOffset: 12 }, ctx);
    expect(ok.payload.intensity).toBe(1);
    expect(() =>
      createEvent(
        'avatar.emotion',
        // @ts-expect-error: emozione fuori vocabolario
        { name: 'ecstatic' },
        ctx,
      ),
    ).toThrow();
    expect(createEvent('avatar.gesture', { name: 'shrug' }, ctx).payload.name).toBe('shrug');
    expect(createEvent('avatar.gaze', { target: 'camera' }, ctx).payload.target).toBe('camera');
  });

  it('conferme tool: richiesta server, risposta client', () => {
    const req = createEvent(
      'tool.confirmation.requested',
      {
        approvalId: ctx.correlationId,
        toolCallId: 'c1',
        toolId: 'shopping_list.add',
        expiresAt: new Date().toISOString(),
      },
      ctx,
    );
    expect(EVENT_DIRECTION[req.type]).toBe('server→client');
    const res = createEvent(
      'tool.confirmation.respond',
      { approvalId: ctx.correlationId, decision: 'approve' },
      ctx,
    );
    expect(parseClientEvent(res).type).toBe('tool.confirmation.respond');
  });
});

describe('assistant.block (v1.2)', () => {
  it('accetta solo blocchi con schema chiuso', () => {
    const ctx = {
      sessionId: '1caaa18b-0446-44a9-9faa-3da78e1e6aac',
      correlationId: '9e2d0c4a-1111-4222-8333-444455556666',
      seq: 1,
    };
    const e = createEvent(
      'assistant.block',
      {
        blockId: 't1',
        block: {
          kind: 'recipes',
          recipes: [{ title: 'Zuppa', ingredients: ['legumi', 'carote'], time: '30 min' }],
        },
      },
      ctx,
    );
    expect(e.payload.block.kind).toBe('recipes');
    expect(() =>
      createEvent(
        'assistant.block',
        { blockId: 't2', block: { kind: 'html', html: '<b>x</b>' } as never },
        ctx,
      ),
    ).toThrow();
  });
});
