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
