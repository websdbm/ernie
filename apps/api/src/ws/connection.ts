import type { CompanionAgent, TurnInput } from '@ernie/agent-core';
import { runTurn as defaultRunTurn } from '@ernie/agent-core';
import { BudgetExceededError, type BudgetGuard, type LlmCallRecorder } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import {
  type AgentEvent,
  type ClientEvent,
  createEvent,
  EventDeduper,
  type EventType,
  type PayloadInputOf,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
  parseClientEvent,
} from '@ernie/protocol';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { SessionForbiddenError, type SessionRecord, type SessionStore } from '../sessions/store.js';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectionDeps {
  readonly logger: Logger;
  readonly store: SessionStore;
  readonly recorder: LlmCallRecorder;
  readonly budget: BudgetGuard;
  readonly dailyBudgetUsd: number;
  /** Costruisce (o recupera dalla cache) l'agente della sessione. Null se nessun provider è configurato. */
  readonly getCompanion: (
    auth: AuthContext,
    session: SessionRecord,
  ) => Promise<CompanionAgent | null>;
  readonly runTurn?: (input: TurnInput) => Promise<unknown>;
}

const uuid = z.uuid();

/** Gestisce una connessione WebSocket: una sessione per connessione, un turno attivo per volta. */
export class ClientConnection {
  private sessionId: string | undefined;
  private session: SessionRecord | undefined;
  private readonly dedupe = new EventDeduper(2048);
  private readonly activeTurns = new Map<string, AbortController>();
  private sending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly socket: SocketLike,
    private readonly auth: AuthContext,
    private readonly deps: ConnectionDeps,
  ) {}

  /** Punto d'ingresso per ogni frame ricevuto. Non lancia mai: gli errori tornano al client come eventi `error`. */
  async handleRaw(data: string | Buffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      await this.sendError('invalid_json', 'Messaggio non valido', false);
      return;
    }
    const res = (() => {
      try {
        return { ok: true as const, event: parseClientEvent(parsed) };
      } catch (err) {
        return { ok: false as const, err };
      }
    })();
    if (!res.ok) {
      await this.sendError('invalid_event', 'Evento non conforme al protocollo v1', false);
      return;
    }
    const event = res.event;
    if (this.dedupe.isDuplicate(event.id)) return;
    try {
      await this.dispatch(event);
    } catch (err) {
      this.deps.logger.error({ err, type: event.type }, "errore nella gestione dell'evento");
      await this.sendError('internal_error', 'Errore interno', true, event.correlationId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const ac of this.activeTurns.values()) ac.abort();
    this.activeTurns.clear();
  }

  // ---------- dispatch ----------

  private async dispatch(event: ClientEvent): Promise<void> {
    switch (event.type) {
      case 'session.start':
        return this.onSessionStart(event);
      case 'user.message':
        return this.onUserMessage(event);
      case 'user.cancel': {
        const ac = this.activeTurns.get(event.payload.targetCorrelationId);
        if (ac) ac.abort();
        return;
      }
      case 'session.ping':
        await this.send(
          'session.pong',
          { serverTime: new Date().toISOString() },
          event.correlationId,
          false,
        );
        return;
      case 'tool.confirmation.respond':
        await this.sendError(
          'not_implemented',
          'Conferme dei tool disponibili dalla M3',
          false,
          event.correlationId,
        );
        return;
      default:
        return;
    }
  }

  private async onSessionStart(
    event: Extract<ClientEvent, { type: 'session.start' }>,
  ): Promise<void> {
    if (!uuid.safeParse(event.sessionId).success) {
      await this.sendError('invalid_session', 'sessionId non valido', false, event.correlationId);
      return;
    }
    if (this.sessionId && this.sessionId !== event.sessionId) {
      await this.sendError(
        'session_mismatch',
        "Questa connessione è già legata a un'altra sessione",
        false,
        event.correlationId,
      );
      return;
    }
    let session: SessionRecord;
    try {
      session = await this.deps.store.ensure(
        this.auth.userId,
        this.auth.apiKeyId,
        event.sessionId,
        event.payload.clientInfo ?? {},
      );
    } catch (err) {
      if (err instanceof SessionForbiddenError) {
        await this.sendError(
          'session_forbidden',
          'Sessione non disponibile',
          false,
          event.correlationId,
        );
        return;
      }
      throw err;
    }
    this.sessionId = session.id;
    this.session = session;

    const resumeFrom = event.payload.resumeFromSeq;
    const replay =
      resumeFrom === undefined ? [] : await this.deps.store.replay(session.id, resumeFrom);
    await this.send(
      'session.started',
      {
        serverTime: new Date().toISOString(),
        protocolVersion: PROTOCOL_VERSION,
        protocolMinor: PROTOCOL_MINOR,
        ...(resumeFrom === undefined
          ? {}
          : { resumedFromSeq: resumeFrom, replayed: replay.length }),
      },
      event.correlationId,
    );
    for (const e of replay) this.socket.send(JSON.stringify(e)); // già numerati: nessun nuovo seq
  }

  private async onUserMessage(
    event: Extract<ClientEvent, { type: 'user.message' }>,
  ): Promise<void> {
    if (!this.sessionId || !this.session) {
      await this.sendError('no_session', 'Invia prima session.start', false, event.correlationId);
      return;
    }
    if (event.sessionId !== this.sessionId) {
      await this.sendError(
        'session_mismatch',
        'sessionId diverso da quello della connessione',
        false,
        event.correlationId,
      );
      return;
    }
    if (this.activeTurns.size > 0) {
      await this.sendError(
        'busy',
        'Un turno è già in corso: attendi o invia user.cancel',
        true,
        event.correlationId,
      );
      return;
    }
    const companion = await this.deps.getCompanion(this.auth, this.session);
    if (!companion) {
      await this.sendError(
        'llm_unavailable',
        'Nessun provider LLM configurato',
        false,
        event.correlationId,
      );
      return;
    }
    try {
      const budget =
        typeof this.auth.settings.dailyBudgetUsd === 'number'
          ? this.auth.settings.dailyBudgetUsd
          : this.deps.dailyBudgetUsd;
      await this.deps.budget.assertWithinBudget(this.auth.userId, budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await this.sendError(
          'budget_exceeded',
          'Budget giornaliero raggiunto',
          false,
          event.correlationId,
        );
        return;
      }
      throw err;
    }

    const ac = new AbortController();
    this.activeTurns.set(event.correlationId, ac);
    const correlationId = event.correlationId;
    const sessionId = this.sessionId;
    const run = this.deps.runTurn ?? defaultRunTurn;
    // Il turno gira in background così `user.cancel` può essere gestito mentre lo stream è aperto.
    void run({
      userId: this.auth.userId,
      sessionId,
      correlationId,
      text: event.payload.text,
      inputMode: event.payload.inputMode,
      companion,
      abortSignal: ac.signal,
      recorder: this.deps.recorder,
      logger: this.deps.logger,
      emit: (type, payload) => this.send(type, payload, correlationId),
    })
      .catch(async (err) => {
        this.deps.logger.error({ err, correlationId }, 'runTurn ha rigettato');
        await this.sendError('turn_failed', 'Il turno non è stato completato', true, correlationId);
      })
      .finally(() => {
        this.activeTurns.delete(correlationId);
        void this.deps.store.touch(this.auth.userId, sessionId).catch(() => {});
      });
  }

  // ---------- invio ----------

  private send<T extends EventType>(
    type: T,
    payload: PayloadInputOf<T>,
    correlationId: string,
    persist?: boolean,
  ): Promise<void> {
    // Serializza gli invii: seq monotono e ordine di emissione garantito anche con emit concorrenti.
    const next = this.sending.then(async () => {
      if (this.closed) return;
      const sessionId = this.sessionId ?? '00000000-0000-4000-8000-000000000000';
      const seq = this.sessionId ? await this.deps.store.nextSeq(this.sessionId) : 0;
      const event: AgentEvent = createEvent(type, payload, {
        sessionId,
        correlationId,
        seq,
        ...(persist === undefined ? {} : { persist }),
      });
      this.socket.send(JSON.stringify(event));
      if (this.sessionId) await this.deps.store.append(this.sessionId, event);
    });
    this.sending = next.catch((err) => this.deps.logger.warn({ err }, 'invio evento fallito'));
    return next;
  }

  private sendError(
    code: string,
    message: string,
    retryable: boolean,
    correlationId?: string,
  ): Promise<void> {
    return this.send(
      'error',
      { code, message, retryable },
      correlationId ?? '00000000-0000-4000-8000-000000000000',
      false,
    );
  }
}
