import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Protocollo Ernie v1 — comunicazione bidirezionale client ⇄ backend (WebSocket o SSE).
 *
 * Ogni messaggio è un envelope con: identificativo, sessione, timestamp, correlation ID
 * (collega tutti gli eventi generati da un singolo `user.message`) e numero di sequenza
 * per direzione (permette riordino, deduplica e ripresa dopo riconnessione).
 */
export const PROTOCOL_VERSION = 1 as const;

export const EnvelopeBase = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.uuid(),
  sessionId: z.uuid(),
  correlationId: z.uuid(),
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
});

// ---------- payload ----------

export const ClientInfo = z.object({
  platform: z.enum(['ios', 'web', 'cli', 'test']),
  appVersion: z.string().max(64).optional(),
  locale: z.string().max(16).optional(),
});

export const RouteKind = z.enum(['deterministic', 'skill', 'llm']);
export const ModelClass = z.enum(['light', 'standard', 'heavy']);

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  routerTokens: z.number().int().nonnegative().optional(),
  memoryTokens: z.number().int().nonnegative().optional(),
  llmCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  costUsdEstimated: z.number().nonnegative().optional(),
  costUsdActual: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative(),
  model: z.string().optional(),
  route: RouteKind.optional(),
});

const event = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  EnvelopeBase.extend({ type: z.literal(type), payload });

// ---------- client → server ----------

export const SessionStart = event(
  'session.start',
  z.object({
    clientInfo: ClientInfo.optional(),
    /** Ultimo seq ricevuto dal client: il server rinvia gli eventi successivi, se disponibili. */
    resumeFromSeq: z.number().int().nonnegative().optional(),
  }),
);

export const UserMessage = event(
  'user.message',
  z.object({
    text: z.string().min(1).max(32_000),
    inputMode: z.enum(['text', 'voice']).default('text'),
    locale: z.string().max(16).optional(),
  }),
);

export const UserCancel = event('user.cancel', z.object({ targetCorrelationId: z.uuid() }));

export const SessionPing = event('session.ping', z.object({}));

// ---------- server → client ----------

export const SessionStarted = event(
  'session.started',
  z.object({
    serverTime: z.iso.datetime(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    resumedFromSeq: z.number().int().nonnegative().optional(),
  }),
);

export const AssistantStarted = event(
  'assistant.started',
  z.object({ route: RouteKind.optional(), modelClass: ModelClass.optional() }),
);

export const AssistantTextDelta = event('assistant.text.delta', z.object({ delta: z.string() }));

export const AssistantTextCompleted = event(
  'assistant.text.completed',
  z.object({ text: z.string() }),
);

export const ToolStarted = event(
  'tool.started',
  z.object({
    toolCallId: z.string().min(1),
    toolId: z.string().min(1),
    displayName: z.string().max(120).optional(),
    argsPreview: z.string().max(500).optional(),
  }),
);

export const ToolCompleted = event(
  'tool.completed',
  z.object({
    toolCallId: z.string().min(1),
    toolId: z.string().min(1),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    resultPreview: z.string().max(500).optional(),
    error: z.string().max(500).optional(),
  }),
);

export const AssistantCompleted = event(
  'assistant.completed',
  z.object({
    usage: Usage.optional(),
    finishReason: z.enum(['stop', 'length', 'tool', 'cancelled', 'error']).optional(),
  }),
);

export const AssistantCancelled = event(
  'assistant.cancelled',
  z.object({ reason: z.enum(['user', 'timeout', 'server']) }),
);

export const ErrorEvent = event(
  'error',
  z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean() }),
);

// ---------- unione ----------

export const ClientEventSchema = z.discriminatedUnion('type', [
  SessionStart,
  UserMessage,
  UserCancel,
  SessionPing,
]);

export const ServerEventSchema = z.discriminatedUnion('type', [
  SessionStarted,
  AssistantStarted,
  AssistantTextDelta,
  AssistantTextCompleted,
  ToolStarted,
  ToolCompleted,
  AssistantCompleted,
  AssistantCancelled,
  ErrorEvent,
]);

export const AgentEventSchema = z.discriminatedUnion('type', [
  ...ClientEventSchema.options,
  ...ServerEventSchema.options,
]);

export type ClientEvent = z.infer<typeof ClientEventSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventInput = z.input<typeof AgentEventSchema>;
export type EventType = AgentEvent['type'];
export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;
export type PayloadOf<T extends EventType> = EventOf<T>['payload'];
export type PayloadInputOf<T extends EventType> = Extract<AgentEventInput, { type: T }>['payload'];
export type UsageReport = z.infer<typeof Usage>;

export type EventDirection = 'client→server' | 'server→client';
export type EventAudience = 'user' | 'runtime';

export const EVENT_DIRECTION = {
  'session.start': 'client→server',
  'user.message': 'client→server',
  'user.cancel': 'client→server',
  'session.ping': 'client→server',
  'session.started': 'server→client',
  'assistant.started': 'server→client',
  'assistant.text.delta': 'server→client',
  'assistant.text.completed': 'server→client',
  'tool.started': 'server→client',
  'tool.completed': 'server→client',
  'assistant.completed': 'server→client',
  'assistant.cancelled': 'server→client',
  error: 'server→client',
} as const satisfies Record<EventType, EventDirection>;

/**
 * `user`: il payload contiene contenuto da mostrare direttamente all'utente.
 * `runtime`: evento di stato/controllo del runtime; il client può usarlo per
 * indicatori di progresso, telemetria o logica interna, ma non va reso come messaggio.
 */
export const EVENT_AUDIENCE = {
  'session.start': 'runtime',
  'user.message': 'user',
  'user.cancel': 'runtime',
  'session.ping': 'runtime',
  'session.started': 'runtime',
  'assistant.started': 'runtime',
  'assistant.text.delta': 'user',
  'assistant.text.completed': 'user',
  'tool.started': 'runtime',
  'tool.completed': 'runtime',
  'assistant.completed': 'runtime',
  'assistant.cancelled': 'user',
  error: 'user',
} as const satisfies Record<EventType, EventAudience>;

export const EVENT_TYPES = Object.keys(EVENT_DIRECTION) as readonly EventType[];

export function isUserVisible(e: Pick<AgentEvent, 'type'>): boolean {
  return EVENT_AUDIENCE[e.type] === 'user';
}

export interface EventContext {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly seq: number;
  readonly id?: string;
  readonly ts?: string;
}

/** Costruisce e valida un evento tipizzato. */
export function createEvent<T extends EventType>(
  type: T,
  payload: PayloadInputOf<T>,
  ctx: EventContext,
): EventOf<T> {
  const candidate = {
    v: PROTOCOL_VERSION,
    id: ctx.id ?? randomUUID(),
    sessionId: ctx.sessionId,
    correlationId: ctx.correlationId,
    seq: ctx.seq,
    ts: ctx.ts ?? new Date().toISOString(),
    type,
    payload,
  };
  return AgentEventSchema.parse(candidate) as EventOf<T>;
}

export function parseEvent(input: unknown): AgentEvent {
  return AgentEventSchema.parse(input);
}

export function safeParseEvent(input: unknown) {
  return AgentEventSchema.safeParse(input);
}

export function parseClientEvent(input: unknown): ClientEvent {
  return ClientEventSchema.parse(input);
}

export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e);
}

export function decodeEvent(raw: string): AgentEvent {
  return parseEvent(JSON.parse(raw));
}
