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
/** Revisione minore compatibile: 1 = persist, cancel con spokenThroughIndex, conferme tool, avatar.*, pong; 2 = blocchi strutturati (`assistant.block`); … 9 = «Consenti sempre» (`allowAlways`, `always`). */
export const PROTOCOL_MINOR = 9 as const;

export const EnvelopeBase = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.uuid(),
  sessionId: z.uuid(),
  correlationId: z.uuid(),
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  /** Se false l'evento non viene conservato nel log di sessione né rinviato in replay (default: true). */
  persist: z.boolean().optional(),
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
    /** v1.3: documenti allegati, già caricati con `POST /v1/documents` (solo testo estratto sul telefono). */
    attachments: z
      .array(z.object({ kind: z.literal('document'), id: z.uuid() }))
      .max(3)
      .optional(),
  }),
);

export const UserCancel = event(
  'user.cancel',
  z.object({
    targetCorrelationId: z.uuid(),
    /** Barge-in: numero di caratteri del testo effettivamente pronunciati dal TTS prima dell'interruzione. */
    spokenThroughIndex: z.number().int().nonnegative().optional(),
  }),
);

export const ToolConfirmationRespond = event(
  'tool.confirmation.respond',
  z.object({
    approvalId: z.uuid(),
    decision: z.enum(['approve', 'deny']),
    /** v1.9: «Consenti sempre» — oltre ad approvare, crea la regola per questo tool. */
    always: z.boolean().optional(),
  }),
);

export const SessionPing = event('session.ping', z.object({}));

// ---------- server → client ----------

export const SessionStarted = event(
  'session.started',
  z.object({
    serverTime: z.iso.datetime(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    protocolMinor: z.number().int().nonnegative().optional(),
    resumedFromSeq: z.number().int().nonnegative().optional(),
    /** Numero di eventi rinviati in replay dopo resumedFromSeq. */
    replayed: z.number().int().nonnegative().optional(),
  }),
);

export const SessionPong = event('session.pong', z.object({ serverTime: z.iso.datetime() }));

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

export const ToolConfirmationRequested = event(
  'tool.confirmation.requested',
  z.object({
    approvalId: z.uuid(),
    toolCallId: z.string().min(1),
    toolId: z.string().min(1),
    displayName: z.string().max(120).optional(),
    argsPreview: z.string().max(500).optional(),
    reason: z.string().max(300).optional(),
    expiresAt: z.iso.datetime(),
    /** v1.9: il tool ammette «Consenti sempre» (nessun effetto esterno). */
    allowAlways: z.boolean().optional(),
  }),
);

export const ToolConfirmationResolved = event(
  'tool.confirmation.resolved',
  z.object({ approvalId: z.uuid(), decision: z.enum(['approved', 'denied', 'expired']) }),
);

/** Vocabolari chiusi allineati a TalkingHead (setMood, playGesture) — ARCHITECTURE.md §13–14. */
export const AvatarEmotionName = z.enum([
  'neutral',
  'happy',
  'angry',
  'sad',
  'fear',
  'disgust',
  'love',
  'sleep',
  // v1.9: espressioni dell'orso in pixel art (M10), oltre al vocabolario di TalkingHead.
  'surprised',
  'playful',
]);
export const AvatarGestureName = z.enum([
  'handup',
  'index',
  'ok',
  'thumbup',
  'thumbdown',
  'side',
  'shrug',
]);
export const AvatarGazeTarget = z.enum(['user', 'camera', 'away']);

const charOffset = z.number().int().nonnegative().optional();

export const AvatarEmotion = event(
  'avatar.emotion',
  z.object({
    name: AvatarEmotionName,
    intensity: z.number().min(0).max(1).default(1),
    charOffset,
    /** v1.9: per quanto mostrarla dopo che Ernie ha finito di parlare (poi torna neutro). */
    durationMs: z.number().int().min(500).max(30_000).optional(),
  }),
);
export const AvatarGesture = event(
  'avatar.gesture',
  z.object({ name: AvatarGestureName, charOffset }),
);
export const AvatarGaze = event('avatar.gaze', z.object({ target: AvatarGazeTarget, charOffset }));

/** v1.9: nuove notifiche nella casella (es. un messaggio spontaneo passato dal gate): il client le rilegge. */
export const InboxUpdated = event(
  'inbox.updated',
  z.object({ kind: z.string().max(80).optional() }),
);

export const AutomationRunUpdated = event(
  'automation.run.updated',
  z.object({
    automationId: z.uuid(),
    runId: z.uuid(),
    status: z.enum([
      'scheduled',
      'claimed',
      'running',
      'succeeded',
      'failed',
      'skipped',
      'budget_exceeded',
      'awaiting_approval',
    ]),
    summary: z.string().max(500).optional(),
  }),
);

/**
 * Blocchi strutturati (v1.2): contenuti con schema chiuso che il client rende come schede native.
 * Li emettono tool e skill (mai testo libero del modello): risultati web, elenchi, ricette.
 */
export const WebResultsBlock = z.object({
  kind: z.literal('web_results'),
  query: z.string().max(300),
  results: z
    .array(
      z.object({
        title: z.string().max(200),
        url: z.url(),
        site: z.string().max(120).optional(),
        snippet: z.string().max(400).optional(),
      }),
    )
    .max(10),
});
export const ListBlock = z.object({
  kind: z.literal('list'),
  title: z.string().max(100),
  items: z
    .array(
      z.object({
        name: z.string().max(120),
        quantity: z.string().max(40).optional(),
        checked: z.boolean().optional(),
      }),
    )
    .max(100),
});
export const RecipeItem = z.object({
  title: z.string().min(1).max(120),
  time: z.string().max(40).optional(),
  servings: z.string().max(40).optional(),
  source: z.string().max(120).optional(),
  url: z.url().optional(),
  ingredients: z.array(z.string().min(1).max(120)).min(1).max(40),
  steps: z.array(z.string().min(1).max(500)).max(20).optional(),
});
export const RecipesBlock = z.object({
  kind: z.literal('recipes'),
  recipes: z.array(RecipeItem).min(1).max(6),
});
/** Mappa (v1.3): nodo ricorsivo, profondità contenuta (il riassuntore la limita a 3 livelli sotto la radice). */
export interface MindNode {
  readonly label: string;
  readonly note?: string | undefined;
  readonly children?: MindNode[] | undefined;
}
export const MindNode: z.ZodType<MindNode> = z.lazy(() =>
  z.object({
    label: z.string().min(1).max(120),
    note: z.string().max(300).optional(),
    children: z.array(MindNode).max(12).optional(),
  }),
);
/** Schema «a frecce» da studio (v1.8): per ogni paragrafo del testo una sezione; dentro, catene di frasi brevi
 * (un solo `next` = la catena prosegue) e ramificazioni (più `next`), come negli appunti scritti a mano. */
export interface OutlineNode {
  readonly label: string;
  readonly next?: OutlineNode[] | undefined;
}
export const OutlineNode: z.ZodType<OutlineNode> = z.lazy(() =>
  z.object({
    label: z.string().min(1).max(160),
    next: z.array(OutlineNode).max(12).optional(),
  }),
);
export const OutlineSection = z.object({
  title: z.string().min(1).max(160),
  nodes: z.array(OutlineNode).min(1).max(40),
});
export const FlowStep = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(160),
  note: z.string().max(300).optional(),
});
export const FlowLink = z.object({
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  label: z.string().max(60).optional(),
});
export const TimelineEvent = z.object({
  when: z.string().min(1).max(60),
  label: z.string().min(1).max(160),
  note: z.string().max(300).optional(),
});
/** Schema grafico di un testo (v1.3): dati chiusi, disegnati nativamente dal client (mai immagini generate). */
export const SchemaDiagram = z.discriminatedUnion('type', [
  z.object({ type: z.literal('outline'), sections: z.array(OutlineSection).min(1).max(60) }),
  z.object({ type: z.literal('mindmap'), root: MindNode }),
  z.object({
    type: z.literal('flow'),
    steps: z.array(FlowStep).min(2).max(30),
    links: z.array(FlowLink).max(60),
  }),
  z.object({ type: z.literal('timeline'), events: z.array(TimelineEvent).min(2).max(40) }),
]);
export type SchemaDiagram = z.infer<typeof SchemaDiagram>;
export const SchemaType = z.enum(['outline', 'mindmap', 'flow', 'timeline']);
export type SchemaType = z.infer<typeof SchemaType>;
/** Scheda di un documento letto (v1.3): prodotti da studio; il testo intero resta sul server. */
export const DocumentBlock = z.object({
  kind: z.literal('document'),
  documentId: z.uuid(),
  title: z.string().min(1).max(160),
  pages: z.number().int().min(1).max(500),
  source: z.enum(['scan', 'photo', 'pdf']),
  abstract: z.string().max(1500),
  keyPoints: z.array(z.string().min(1).max(300)).max(12),
  glossary: z
    .array(z.object({ term: z.string().min(1).max(60), definition: z.string().min(1).max(300) }))
    .max(12)
    .optional(),
  questions: z
    .array(z.object({ question: z.string().min(1).max(300), answer: z.string().min(1).max(400) }))
    .max(10)
    .optional(),
});
export const SchemaBlock = z.object({
  kind: z.literal('schema'),
  documentId: z.uuid(),
  title: z.string().min(1).max(160),
  diagram: SchemaDiagram,
});
/** Lista della spesa interattiva (v1.4): le voci si spuntano, aggiungono e tolgono dalla scheda via REST. */
export const ShoppingListItem = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  quantity: z.string().max(40).optional(),
  checked: z.boolean(),
});
export const ShoppingListBlock = z.object({
  kind: z.literal('shopping_list'),
  listId: z.uuid(),
  name: z.string().min(1).max(60),
  status: z.enum(['active', 'archived']),
  items: z.array(ShoppingListItem).max(200),
});
/** Scelta tra più liste (v1.4): toccandone una, l'app rimanda `pendingText` con il nome della lista. */
export const ShoppingListsBlock = z.object({
  kind: z.literal('shopping_lists'),
  title: z.string().max(100),
  lists: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(60),
        open: z.number().int().min(0),
        bought: z.number().int().min(0),
        archived: z.boolean(),
      }),
    )
    .max(50),
  pendingText: z.string().max(500).optional(),
});
/** Documenti letti (v1.5): scelta toccabile; l'app rimanda `pendingText` con il titolo al posto di `{documento}`. */
export const DocumentsBlock = z.object({
  kind: z.literal('documents'),
  title: z.string().max(100),
  documents: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().min(1).max(160),
        pages: z.number().int().min(1),
        source: z.enum(['scan', 'photo', 'pdf']),
        summarized: z.boolean(),
        createdAt: z.string().max(40),
      }),
    )
    .max(50),
  pendingText: z.string().max(500).optional(),
});
/** Promemoria (v1.6): elenco con annullamento dalla scheda; l'app programma anche una notifica locale. */
export const RemindersBlock = z.object({
  kind: z.literal('reminders'),
  title: z.string().max(100),
  reminders: z
    .array(
      z.object({
        id: z.uuid(),
        text: z.string().min(1).max(300),
        at: z.iso.datetime(),
        status: z.enum(['scheduled', 'done', 'cancelled']),
        /** v1.7 (Famiglia): messo da me a «Giorgio» / messo a me da «papà». */
        for: z.string().min(1).max(60).optional(),
        from: z.string().min(1).max(60).optional(),
      }),
    )
    .max(50),
});
/** Fonti (v1.9, ricerca 11 S2): pagine dei documenti citate nella risposta e verificate dal server. */
export const CitationsBlock = z.object({
  kind: z.literal('citations'),
  title: z.string().max(100),
  items: z
    .array(
      z.object({
        documentId: z.uuid(),
        title: z.string().min(1).max(160),
        page: z.number().int().min(1),
        heading: z.string().max(120).nullable(),
        excerpt: z.string().max(400),
      }),
    )
    .min(1)
    .max(6),
});
export const ContentBlock = z.discriminatedUnion('kind', [
  WebResultsBlock,
  ListBlock,
  RecipesBlock,
  DocumentBlock,
  SchemaBlock,
  ShoppingListBlock,
  ShoppingListsBlock,
  DocumentsBlock,
  RemindersBlock,
  CitationsBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const AssistantBlock = event(
  'assistant.block',
  z.object({ blockId: z.string().min(1), block: ContentBlock }),
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
  ToolConfirmationRespond,
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
  SessionPong,
  ToolConfirmationRequested,
  ToolConfirmationResolved,
  AvatarEmotion,
  AvatarGesture,
  AvatarGaze,
  AutomationRunUpdated,
  InboxUpdated,
  AssistantBlock,
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
  'tool.confirmation.respond': 'client→server',
  'session.started': 'server→client',
  'assistant.started': 'server→client',
  'assistant.text.delta': 'server→client',
  'assistant.text.completed': 'server→client',
  'tool.started': 'server→client',
  'tool.completed': 'server→client',
  'assistant.completed': 'server→client',
  'assistant.cancelled': 'server→client',
  'session.pong': 'server→client',
  'tool.confirmation.requested': 'server→client',
  'tool.confirmation.resolved': 'server→client',
  'avatar.emotion': 'server→client',
  'avatar.gesture': 'server→client',
  'avatar.gaze': 'server→client',
  'automation.run.updated': 'server→client',
  'inbox.updated': 'server→client',
  'assistant.block': 'server→client',
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
  'tool.confirmation.respond': 'runtime',
  'session.started': 'runtime',
  'assistant.started': 'runtime',
  'assistant.text.delta': 'user',
  'assistant.text.completed': 'user',
  'tool.started': 'runtime',
  'tool.completed': 'runtime',
  'assistant.completed': 'runtime',
  'assistant.cancelled': 'user',
  'session.pong': 'runtime',
  'tool.confirmation.requested': 'user',
  'tool.confirmation.resolved': 'runtime',
  'avatar.emotion': 'runtime',
  'avatar.gesture': 'runtime',
  'avatar.gaze': 'runtime',
  'automation.run.updated': 'user',
  'inbox.updated': 'user',
  'assistant.block': 'user',
  error: 'user',
} as const satisfies Record<EventType, EventAudience>;

export const EVENT_TYPES = Object.keys(EVENT_DIRECTION) as readonly EventType[];

export function isUserVisible(e: Pick<AgentEvent, 'type'>): boolean {
  return EVENT_AUDIENCE[e.type] === 'user';
}

/** Eventi da conservare nel log di sessione per il replay: tutti, salvo `persist: false` e i ping/pong. */
export function shouldPersist(e: Pick<AgentEvent, 'type' | 'persist'>): boolean {
  if (e.persist === false) return false;
  return e.type !== 'session.ping' && e.type !== 'session.pong';
}

export interface EventContext {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly seq: number;
  readonly id?: string;
  readonly ts?: string;
  readonly persist?: boolean;
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
    ...(ctx.persist === undefined ? {} : { persist: ctx.persist }),
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
