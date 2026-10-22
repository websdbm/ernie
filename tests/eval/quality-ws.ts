import { randomUUID } from 'node:crypto';
import { createEvent, decodeEvent, PROTOCOL_VERSION, SequenceSource } from '@ernie/protocol';
import type { QualityTransport, TransportFactory, TurnEvidence } from './quality-types.js';

/** This is an additional client guard. Server fixture isolation remains mandatory. */
export const EVAL_TOOLS = new Set([
  'get_time',
  'memory_search',
  'reminder_create',
  'reminder_list',
  'shopping_list_get',
  'shopping_list_add',
  'shopping_lists',
  'todo_lists',
  'todo_get',
  'todo_save',
  'brain_search',
  'brain_read',
  'brain_write',
  'recipe_search',
  'recipe_get',
  'recipe_save',
  'present_recipes',
  'present_choices',
]);
export interface EvalSocket {
  send(value: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}
export type SocketFactory = (url: string, key: string) => EvalSocket;
const socketFactory: SocketFactory = (url, key) =>
  new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
  } as unknown as string[]) as unknown as EvalSocket;

export function createWebSocketTransport(
  makeSocket: SocketFactory = socketFactory,
): TransportFactory {
  return async ({ wsUrl, apiKey, sessionId, timeoutMs }): Promise<QualityTransport> => {
    const ws = makeSocket(wsUrl, apiKey);
    const seq = new SequenceSource();
    const handshakeId = randomUUID();
    let current:
      | {
          correlationId: string;
          start: number;
          result: TurnEvidence;
          seen: Set<string>;
          blocks: Map<string, TurnEvidence['blocks'][number]>;
          done: (e: TurnEvidence) => void;
          timer: ReturnType<typeof setTimeout>;
          retryTimer?: ReturnType<typeof setTimeout>;
          text: string;
        }
      | undefined;
    let connected = false;
    let resolveReady: () => void = () => {};
    let rejectReady: () => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = () => reject(new Error('ws_handshake_failed'));
    });
    const handshakeTimer = setTimeout(
      () => {
        rejectReady();
        ws.close();
      },
      Math.min(timeoutMs, 10_000),
    );
    const finish = (terminal: TurnEvidence['terminal'], errorCode?: string) => {
      if (!current) return;
      const active = current;
      current = undefined;
      clearTimeout(active.timer);
      clearTimeout(active.retryTimer);
      active.result.terminal = terminal;
      active.result.blocks = [...active.blocks.values()];
      active.result.completedMs =
        terminal === 'completed' ? Math.round(performance.now() - active.start) : null;
      if (errorCode)
        active.result.errorCode = /^[a-z0-9_:-]{1,64}$/i.test(errorCode)
          ? errorCode
          : 'server_error';
      active.done(active.result);
    };
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify(
          createEvent(
            'session.start',
            { clientInfo: { platform: 'test', appVersion: 'quality-eval-v1', locale: 'it-IT' } },
            { sessionId, correlationId: handshakeId, seq: seq.next() },
          ),
        ),
      );
    });
    ws.addEventListener('message', (message) => {
      let event: ReturnType<typeof decodeEvent>;
      try {
        event = decodeEvent(String(message.data));
      } catch {
        finish('error', 'invalid_protocol');
        rejectReady();
        ws.close();
        return;
      }
      if (event.sessionId !== sessionId || event.v !== PROTOCOL_VERSION) return;
      if (!connected && event.type === 'session.started' && event.correlationId === handshakeId) {
        connected = true;
        clearTimeout(handshakeTimer);
        resolveReady();
        return;
      }
      if (!current || event.correlationId !== current.correlationId) return;
      if (current.seen.has(event.id)) return;
      current.seen.add(event.id);
      current.result.eventIds.push(event.id);
      if (current.seen.size > 2000 || current.result.text.length > 100_000) {
        finish('error', 'response_limit');
        ws.close();
        return;
      }
      const first = () => {
        if (current && current.result.firstResponseMs === null)
          current.result.firstResponseMs = Math.round(performance.now() - current.start);
      };
      switch (event.type) {
        case 'assistant.text.delta':
          if (event.payload.delta.trim()) first();
          current.result.text += event.payload.delta;
          break;
        case 'assistant.text.completed':
          if (event.payload.text.trim()) first();
          current.result.text = event.payload.text;
          break;
        case 'assistant.block':
          first();
          current.blocks.set(event.payload.blockId, event.payload.block);
          break;
        case 'tool.confirmation.requested': {
          first();
          const allowed = EVAL_TOOLS.has(event.payload.toolId);
          ws.send(
            JSON.stringify(
              createEvent(
                'tool.confirmation.respond',
                { approvalId: event.payload.approvalId, decision: allowed ? 'approve' : 'deny' },
                { sessionId, correlationId: current.correlationId, seq: seq.next() },
              ),
            ),
          );
          if (!allowed) {
            finish('error', 'forbidden_tool');
            ws.close();
          }
          break;
        }
        case 'tool.started':
          if (!EVAL_TOOLS.has(event.payload.toolId)) {
            ws.send(
              JSON.stringify(
                createEvent(
                  'user.cancel',
                  { targetCorrelationId: current.correlationId },
                  { sessionId, correlationId: randomUUID(), seq: seq.next() },
                ),
              ),
            );
            finish('error', 'forbidden_tool');
            ws.close();
          } else if (!current.result.tools.some((t) => t.callId === event.payload.toolCallId))
            current.result.tools.push({
              callId: event.payload.toolCallId,
              id: event.payload.toolId,
              ok: null,
            });
          break;
        case 'tool.completed': {
          if (!EVAL_TOOLS.has(event.payload.toolId)) {
            finish('error', 'forbidden_tool');
            ws.close();
            break;
          }
          const tool = current.result.tools.find((t) => t.callId === event.payload.toolCallId);
          if (tool) tool.ok = event.payload.ok;
          else
            current.result.tools.push({
              callId: event.payload.toolCallId,
              id: event.payload.toolId,
              ok: event.payload.ok,
            });
          break;
        }
        case 'assistant.completed': {
          const reason = event.payload.finishReason;
          finish(
            reason === 'error' || reason === 'length'
              ? 'error'
              : reason === 'cancelled'
                ? 'cancelled'
                : 'completed',
            reason === 'length' ? 'truncated' : undefined,
          );
          break;
        }
        case 'assistant.cancelled':
          finish('cancelled');
          break;
        case 'error': {
          const retries = current.result.busyRetries ?? 0;
          if (event.payload.code === 'busy' && event.payload.retryable && retries < 3) {
            const active = current;
            active.result.busyRetries = retries + 1;
            clearTimeout(active.retryTimer);
            active.retryTimer = setTimeout(
              () => {
                if (current !== active || !connected) return;
                ws.send(
                  JSON.stringify(
                    createEvent(
                      'user.message',
                      { text: active.text, device: { timezone: 'Europe/Rome' } },
                      { sessionId, correlationId: active.correlationId, seq: seq.next() },
                    ),
                  ),
                );
              },
              150 * 2 ** retries,
            );
          } else finish('error', event.payload.code);
          break;
        }
      }
    });
    const disconnected = () => {
      clearTimeout(handshakeTimer);
      rejectReady();
      finish('disconnect');
      connected = false;
    };
    ws.addEventListener('error', disconnected);
    ws.addEventListener('close', disconnected);
    try {
      await ready;
    } catch {
      clearTimeout(handshakeTimer);
      ws.close();
      throw new Error('ws_handshake_failed');
    }
    return {
      turn(text, correlationId) {
        if (!connected || current) throw new Error('ws_unavailable');
        return new Promise<TurnEvidence>((done) => {
          const timer = setTimeout(() => {
            if (current)
              ws.send(
                JSON.stringify(
                  createEvent(
                    'user.cancel',
                    { targetCorrelationId: current.correlationId },
                    { sessionId, correlationId: randomUUID(), seq: seq.next() },
                  ),
                ),
              );
            finish('timeout');
            ws.close();
          }, timeoutMs);
          current = {
            correlationId,
            text,
            start: performance.now(),
            result: {
              terminal: 'error',
              firstResponseMs: null,
              completedMs: null,
              text: '',
              tools: [],
              blocks: [],
              eventIds: [],
            },
            seen: new Set(),
            blocks: new Map(),
            done,
            timer,
          };
          ws.send(
            JSON.stringify(
              createEvent(
                'user.message',
                { text, device: { timezone: 'Europe/Rome' } },
                { sessionId, correlationId, seq: seq.next() },
              ),
            ),
          );
        });
      },
      close() {
        clearTimeout(handshakeTimer);
        finish('disconnect');
        ws.close();
      },
    };
  };
}
