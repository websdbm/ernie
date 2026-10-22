import { randomUUID } from 'node:crypto';
import { createEvent, PROTOCOL_VERSION } from '@ernie/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebSocketTransport, type EvalSocket } from './quality-ws.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}

class FakeSocket implements EvalSocket {
  sent: Array<ReturnType<typeof createEvent>> = [];
  closed = false;
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closed = true;
    this.emit('close', {});
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  event(
    type: Parameters<typeof createEvent>[0],
    payload: unknown,
    correlationId: string,
    sessionId: string,
  ) {
    const event = createEvent(type, payload as never, {
      correlationId,
      sessionId,
      seq: this.sent.length + 1,
    });
    this.emit('message', { data: JSON.stringify(event) });
    return event;
  }
}
async function connected() {
  const socket = new FakeSocket();
  const sessionId = randomUUID();
  const promise = createWebSocketTransport(() => socket)({
    wsUrl: 'ws://localhost/test',
    apiKey: 'test-only',
    sessionId,
    timeoutMs: 1000,
  });
  socket.emit('open', {});
  const handshake = required(socket.sent[0]);
  expect(handshake.type).toBe('session.start');
  socket.event(
    'session.started',
    { serverTime: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION },
    handshake.correlationId,
    sessionId,
  );
  return { socket, sessionId, transport: await promise };
}

afterEach(() => {
  vi.useRealTimers();
});
describe('real protocol WebSocket client without a network or model', () => {
  it('times first visible response, ignores other sessions, deduplicates event IDs and retains full text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { socket, sessionId, transport } = await connected();
    const correlationId = randomUUID();
    const result = transport.turn('Sintetico', correlationId);
    socket.event('assistant.started', {}, correlationId, sessionId);
    await vi.advanceTimersByTimeAsync(20);
    socket.event('assistant.text.delta', { delta: 'foreign' }, correlationId, randomUUID());
    await vi.advanceTimersByTimeAsync(10);
    const delta = socket.event(
      'assistant.text.delta',
      { delta: 'Fatto' },
      correlationId,
      sessionId,
    );
    socket.emit('message', { data: JSON.stringify(delta) });
    await vi.advanceTimersByTimeAsync(30);
    socket.event('assistant.text.completed', { text: 'Fatto, salvato.' }, correlationId, sessionId);
    socket.event('assistant.completed', { finishReason: 'stop' }, correlationId, sessionId);
    expect(await result).toMatchObject({
      terminal: 'completed',
      firstResponseMs: 30,
      completedMs: 60,
      text: 'Fatto, salvato.',
    });
    expect((await result).eventIds).toHaveLength(4);
    transport.close();
  });
  it('busy retries keep correlationId but use fresh IDs and increasing seq; replay does the same', async () => {
    vi.useFakeTimers();
    const { socket, sessionId, transport } = await connected();
    const correlationId = randomUUID();
    const first = transport.turn('Aggiungi cacao', correlationId);
    const original = required(socket.sent.at(-1));
    socket.event(
      'error',
      { code: 'busy', message: 'busy', retryable: true },
      correlationId,
      sessionId,
    );
    await vi.advanceTimersByTimeAsync(150);
    const retry = required(socket.sent.at(-1));
    expect(retry.correlationId).toBe(original.correlationId);
    expect(retry.id).not.toBe(original.id);
    expect(retry.seq).toBeGreaterThan(original.seq);
    expect(retry.payload).toEqual(original.payload);
    socket.event('assistant.text.completed', { text: 'Fatto' }, correlationId, sessionId);
    socket.event('assistant.completed', {}, correlationId, sessionId);
    expect((await first).busyRetries).toBe(1);
    const replay = transport.turn('Aggiungi cacao', correlationId);
    const replayEvent = required(socket.sent.at(-1));
    expect(replayEvent.correlationId).toBe(correlationId);
    expect(replayEvent.id).not.toBe(retry.id);
    socket.event('assistant.text.completed', { text: 'Fatto' }, correlationId, sessionId);
    socket.event('assistant.completed', {}, correlationId, sessionId);
    await replay;
    transport.close();
  });
  it('timeout sends cancellation and resolves with no successful completion timing', async () => {
    vi.useFakeTimers();
    const { socket, transport } = await connected();
    const correlationId = randomUUID();
    const result = transport.turn('Sintetico', correlationId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ terminal: 'timeout', completedMs: null });
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'user.cancel',
      payload: { targetCorrelationId: correlationId },
    });
    expect(socket.closed).toBe(true);
  });
  it('rejects invalid protocol and terminal truncation rather than treating delivery as success', async () => {
    const first = await connected();
    const result = first.transport.turn('Sintetico', randomUUID());
    first.socket.emit('message', { data: JSON.stringify({ status: 200 }) });
    expect(await result).toMatchObject({ terminal: 'error', errorCode: 'invalid_protocol' });
    expect(first.socket.closed).toBe(true);
    const second = await connected();
    const correlationId = randomUUID();
    const truncated = second.transport.turn('Sintetico', correlationId);
    second.socket.event(
      'assistant.completed',
      { finishReason: 'length' },
      correlationId,
      second.sessionId,
    );
    expect(await truncated).toMatchObject({ terminal: 'error', errorCode: 'truncated' });
    second.transport.close();
  });
  it('denies forbidden confirmations, approves only allowed tool once and never grants always', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { socket, sessionId, transport } = await connected();
    const correlationId = randomUUID();
    const result = transport.turn('Sintetico', correlationId);
    const request = {
      approvalId: randomUUID(),
      toolCallId: 'call1',
      toolId: 'reminder_create',
      expiresAt: '2031-01-01T00:00:00Z',
      allowAlways: true,
    };
    await vi.advanceTimersByTimeAsync(25);
    const event = socket.event('tool.confirmation.requested', request, correlationId, sessionId);
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'tool.confirmation.respond',
      payload: { approvalId: request.approvalId, decision: 'approve' },
    });
    expect(socket.sent.at(-1)?.payload).not.toHaveProperty('always');
    const count = socket.sent.length;
    socket.emit('message', { data: JSON.stringify(event) });
    expect(socket.sent).toHaveLength(count);
    socket.event(
      'tool.confirmation.requested',
      { ...request, approvalId: randomUUID(), toolId: 'email_send' },
      correlationId,
      sessionId,
    );
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'tool.confirmation.respond',
      payload: { decision: 'deny' },
    });
    expect(await result).toMatchObject({
      terminal: 'error',
      errorCode: 'forbidden_tool',
      firstResponseMs: 25,
    });
    expect(socket.closed).toBe(true);
  });
  it('records unsuccessful calls separately and preserves server block replacement semantics', async () => {
    const { socket, sessionId, transport } = await connected();
    const correlationId = randomUUID();
    const result = transport.turn('Sintetico', correlationId);
    socket.event(
      'tool.started',
      { toolCallId: 'one', toolId: 'brain_write' },
      correlationId,
      sessionId,
    );
    socket.event(
      'tool.completed',
      { toolCallId: 'one', toolId: 'brain_write', ok: false, durationMs: 5 },
      correlationId,
      sessionId,
    );
    socket.event(
      'tool.started',
      { toolCallId: 'two', toolId: 'brain_write' },
      correlationId,
      sessionId,
    );
    socket.event(
      'tool.completed',
      { toolCallId: 'two', toolId: 'brain_write', ok: true, durationMs: 5 },
      correlationId,
      sessionId,
    );
    const blockId = randomUUID();
    const block = {
      kind: 'shopping_list',
      listId: randomUUID(),
      name: 'Spesa',
      status: 'active',
      items: [],
    };
    socket.event('assistant.block', { blockId, block }, correlationId, sessionId);
    socket.event(
      'assistant.block',
      { blockId, block: { ...block, name: 'Spesa aggiornata' } },
      correlationId,
      sessionId,
    );
    socket.event('assistant.text.completed', { text: 'Salvato' }, correlationId, sessionId);
    socket.event('assistant.completed', {}, correlationId, sessionId);
    expect((await result).tools.map((tool) => tool.ok)).toEqual([false, true]);
    expect((await result).blocks).toHaveLength(1);
    expect((await result).blocks[0]?.name).toBe('Spesa aggiornata');
    transport.close();
  });
});
