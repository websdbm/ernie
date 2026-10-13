import { randomUUID } from 'node:crypto';
import type { ApprovalStore, CompanionAgent, PendingApprovals, TurnInput } from '@ernie/agent-core';
import { runTurn as defaultRunTurn, RunContext, routeCommand } from '@ernie/agent-core';
import type { DecisionRouter, RouteDecision } from '@ernie/jev-router';
import { formatRetrievedMemories, type MemoryRepository } from '@ernie/memory';
import { BudgetExceededError, type BudgetGuard, type LlmCallRecorder } from '@ernie/model-gateway';
import type { Logger } from '@ernie/observability';
import {
  type AgentEvent,
  type ClientEvent,
  type ContentBlock,
  createEvent,
  EventDeduper,
  type EventType,
  type PayloadInputOf,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
  parseClientEvent,
} from '@ernie/protocol';
import type { SkillRegistry } from '@ernie/skills';
import type { ToolContextRef, ToolRuleStore } from '@ernie/tools';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { type DocumentsFlow, parseDocumentRequest, parseSchemaCommand } from '../documents-flow.js';
import type { RouterDecisionRecorder } from '../router/recorder.js';
import { SessionForbiddenError, type SessionRecord, type SessionStore } from '../sessions/store.js';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface TurnOutcomeInfo {
  userId: string;
  sessionId: string;
  requestId: string;
  userText: string;
  route: string;
  modelClass: string;
  model?: string;
  outcome: 'completed' | 'cancelled' | 'error' | 'loop';
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  latencyMs: number;
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
  /** Invalida l'agente in cache (cambio di classe o di contesto). */
  readonly invalidateCompanion: (sessionId: string) => void;
  readonly router: DecisionRouter;
  readonly decisions: RouterDecisionRecorder;
  readonly approvals?: {
    store: ApprovalStore;
    pending: PendingApprovals;
    /** «Consenti sempre» dalla scheda di conferma (v1.9). */
    rules?: Pick<ToolRuleStore, 'allowFromApproval'>;
  };
  readonly memories?: {
    readonly repo: MemoryRepository;
    readonly retrievalLimit: number;
    /** Chiamato a fine turno: episodio deterministico e consolidamento asincrono. */
    readonly afterTurn: (info: TurnOutcomeInfo) => Promise<void>;
  };
  /** Tool e skill (M5): categorie per Jev, contesto per turno, skill deterministiche prima di Jev. */
  readonly tools?: {
    readonly categories: readonly string[];
    readonly setToolContext: (sessionId: string, ctx: ToolContextRef['current']) => void;
    /** Durata della contaminazione di sessione dopo contenuto non fidato. */
    readonly taintTtlSeconds?: number;
  };
  readonly skills?: {
    readonly registryFor: (
      auth: Pick<AuthContext, 'userId' | 'settings'>,
    ) => Promise<SkillRegistry>;
  };
  /** Allegati (v1.3): descrizione di un documento già caricato, per annotare il messaggio al modello. */
  readonly documents?: {
    readonly describe: (
      userId: string,
      id: string,
    ) => Promise<{ id: string; title: string; pages: number; source: string } | null>;
    /** Percorso deterministico (riassunto e schema dell'allegato, schema di un documento per titolo). */
    readonly flow?: DocumentsFlow;
  };
  readonly runTurn?: (input: TurnInput) => Promise<unknown>;
}

const NULL_UUID = '00000000-0000-4000-8000-000000000000';
const uuid = z.uuid();

const localDecision = (
  route: 'deterministic' | 'skill',
  modelClass: RouteDecision['modelClass'],
  latencyMs: number,
  skillId: string | null = null,
): RouteDecision => ({
  route,
  modelClass,
  deepReasoning: false,
  needsMemory: false,
  toolCategories: [],
  skillId,
  riskSignal: 0,
  confidence: 1,
  source: 'deterministic',
  costUsd: 0,
  inputTokens: 0,
  latencyMs,
});

/** Gestisce una connessione WebSocket: una sessione per connessione, un turno attivo per volta. */
export class ClientConnection {
  private sessionId: string | undefined;
  private session: SessionRecord | undefined;
  private readonly dedupe = new EventDeduper(2048);
  private readonly activeTurns = new Map<string, AbortController>();
  /** Barge-in: fino a quale carattere l'utente ha sentito la risposta che ha interrotto (per correlationId). */
  private readonly spokenThrough = new Map<string, number>();
  /** Ultima risposta interrotta dall'utente: ciò che ha sentito e ciò che non ha sentito (per il turno successivo). */
  private interruptedReply: { heard: string; unheard: string } | undefined;
  /** Ultimi scambi (max 6 righe) per lo state del router: non persistiti. */
  private readonly recentTurns: string[] = [];
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
    let event: ClientEvent;
    try {
      event = parseClientEvent(parsed);
    } catch {
      await this.sendError('invalid_event', 'Evento non conforme al protocollo v1', false);
      return;
    }
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

  get userId(): string {
    return this.auth.userId;
  }

  /** Evento server→client fuori turno (es. stato di un'automazione): solo con sessione avviata. */
  async push<T extends EventType>(type: T, payload: PayloadInputOf<T>): Promise<boolean> {
    if (!this.sessionId || this.closed) return false;
    await this.send(type, payload, randomUUID());
    return true;
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
        if (ac) {
          if (event.payload.spokenThroughIndex !== undefined)
            this.spokenThrough.set(
              event.payload.targetCorrelationId,
              event.payload.spokenThroughIndex,
            );
          ac.abort();
        }
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
      case 'tool.confirmation.respond': {
        if (!this.deps.approvals) {
          await this.sendError(
            'not_implemented',
            'Conferme dei tool non attive',
            false,
            event.correlationId,
          );
          return;
        }
        const decision = event.payload.decision === 'approve' ? 'approved' : 'denied';
        const outcome = await this.deps.approvals.store.resolve(
          this.auth.userId,
          event.payload.approvalId,
          decision,
        );
        if (outcome === 'not_found') {
          await this.sendError(
            'approval_not_found',
            'Approvazione inesistente o già decisa',
            false,
            event.correlationId,
          );
          return;
        }
        // «Consenti sempre»: la regola nasce solo da un'approvazione valida e solo per tool ammessi.
        if (outcome === 'approved' && event.payload.always && this.deps.approvals.rules) {
          try {
            const rule = await this.deps.approvals.rules.allowFromApproval(
              this.auth.userId,
              event.payload.approvalId,
            );
            this.deps.logger.info(
              { userId: this.auth.userId, toolId: rule?.toolId ?? null },
              rule ? 'regola «consenti sempre» creata' : 'regola «consenti sempre» non ammessa',
            );
          } catch (err) {
            this.deps.logger.warn({ err }, 'regola «consenti sempre» non salvata');
          }
        }
        this.deps.approvals.pending.settle(event.payload.approvalId, outcome);
        await this.send(
          'tool.confirmation.resolved',
          { approvalId: event.payload.approvalId, decision: outcome },
          event.correlationId,
        );
        return;
      }
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
        'Ernie sta ancora rispondendo: il messaggio partirà subito dopo.',
        true,
        event.correlationId,
      );
      return;
    }
    const t0 = Date.now();
    const correlationId = event.correlationId;
    const sessionId = this.sessionId;
    const text = event.payload.text;
    // Allegati (v1.3): il modello riceve il testo annotato con titolo e id dei documenti; la skill «Documenti» guida il turno.
    const attachments = event.payload.attachments ?? [];
    const attachmentNotes: string[] = [];
    for (const a of attachments) {
      const d = await this.deps.documents?.describe(this.auth.userId, a.id);
      if (!d) {
        await this.sendError(
          'document_not_found',
          'Documento allegato inesistente',
          false,
          correlationId,
        );
        return;
      }
      attachmentNotes.push(
        `[Allegato a questo messaggio: documento «${d.title}», id=${d.id}, ${d.pages} ${d.pages === 1 ? 'pagina' : 'pagine'}, fonte ${d.source}. Lavora SOLO su questo documento (questo id), non su documenti precedenti.]`,
      );
    }
    // Allegato senza una domanda: riassunto e schema vengono prodotti qui, senza passare dal modello
    // (che in passato ha riusato un documento precedente). Con una domanda il modello entra, annotato.
    const flow = this.deps.documents?.flow;
    const attachedId = attachments[0]?.id;
    if (flow && attachedId) {
      const req = parseDocumentRequest(text);
      if (!req.question) {
        const reply = await this.runDocumentsFlow(
          () =>
            flow.attached(
              { userId: this.auth.userId, sessionId, requestId: correlationId },
              attachedId,
              req,
            ),
          correlationId,
          t0,
          text,
        );
        if (reply) return;
      }
    } else if (flow && attachments.length === 0) {
      const cmd = parseSchemaCommand(text);
      if (cmd) {
        const reply = await this.runDocumentsFlow(
          () =>
            flow.schemaByTitle(
              { userId: this.auth.userId, sessionId, requestId: correlationId },
              cmd.title,
              cmd.type,
            ),
          correlationId,
          t0,
          text,
        );
        if (reply) return;
      }
    }
    // La riga dell'allegato precede il testo: il modello la vede subito e non la scambia per un riferimento a documenti passati.
    const modelText = attachmentNotes.length ? `${attachmentNotes.join('\n')}\n\n${text}` : text;
    const budget =
      typeof this.auth.settings.dailyBudgetUsd === 'number'
        ? this.auth.settings.dailyBudgetUsd
        : this.deps.dailyBudgetUsd;

    // 1) Router deterministico: comandi riconosciuti → nessuna chiamata a Jev né a un modello.
    const command = routeCommand(text, {
      companionName: this.auth.companionName,
      modelClass: this.session.modelClass,
      contextTags: this.session.contextTags,
      spentTodayUsd: await this.spentToday(),
      budgetUsd: budget,
      role: this.auth.role,
    });
    if (command.kind !== 'none' && attachments.length === 0) {
      if (command.kind === 'set_class') {
        const effective = await this.deps.store.raiseModelClass(
          this.auth.userId,
          sessionId,
          command.modelClass,
        );
        this.session = { ...this.session, modelClass: effective };
        this.deps.invalidateCompanion(sessionId);
      } else if (command.kind === 'set_context') {
        await this.deps.store.setContextTags(this.auth.userId, sessionId, command.tags);
        this.session = { ...this.session, contextTags: command.tags };
        this.deps.invalidateCompanion(sessionId);
      }
      await this.deps.decisions.record(
        this.auth.userId,
        sessionId,
        correlationId,
        localDecision('deterministic', this.session.modelClass, Date.now() - t0),
      );
      await this.replyLocally('deterministic', command.text, correlationId, t0, text);
      return;
    }

    // 2) Skill deterministiche (procedure note): riconosciute con regole, eseguite senza modelli.
    const skills = this.deps.skills ? await this.deps.skills.registryFor(this.auth) : null;
    const match = attachments.length === 0 ? (skills?.match(text) ?? null) : null;
    if (match) {
      const reply = await match.skill.run(match.plan, {
        userId: this.auth.userId,
        sessionId,
        requestId: correlationId,
      });
      await this.deps.decisions.record(
        this.auth.userId,
        sessionId,
        correlationId,
        localDecision('skill', this.session.modelClass, Date.now() - t0, match.skill.id),
      );
      await this.replyLocally('skill', reply.text, correlationId, t0, text, reply.blocks);
      await this.deps.memories?.afterTurn({
        userId: this.auth.userId,
        sessionId,
        requestId: correlationId,
        userText: text,
        route: 'skill',
        modelClass: this.session.modelClass,
        outcome: 'completed',
        costUsd: 0,
        llmCalls: 0,
        toolCalls: reply.actions.length,
        latencyMs: Date.now() - t0,
      });
      return;
    }

    // 3) Budget, poi decisione (cache → Jev → fallback); il Policy Engine può solo restringere.
    try {
      await this.deps.budget.assertWithinBudget(this.auth.userId, budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await this.sendError(
          'budget_exceeded',
          'Budget giornaliero raggiunto',
          false,
          correlationId,
        );
        return;
      }
      throw err;
    }
    const decision = await this.deps.router.decide({
      text: modelText,
      inputMode: event.payload.inputMode,
      recentTurns: this.recentTurns,
      toolCategories: this.deps.tools?.categories ?? [],
      skillCandidates: skills?.candidates(text) ?? [],
      sessionModelClass: this.session.modelClass,
    });
    await this.deps.decisions.record(this.auth.userId, sessionId, correlationId, decision);
    if (decision.modelClass === 'heavy' && this.session.modelClass !== 'heavy') {
      const effective = await this.deps.store.raiseModelClass(this.auth.userId, sessionId, 'heavy');
      this.session = { ...this.session, modelClass: effective };
      this.deps.invalidateCompanion(sessionId);
    }

    const companion = await this.deps.getCompanion(this.auth, this.session);
    if (!companion) {
      await this.sendError(
        'llm_unavailable',
        'Nessun provider LLM configurato',
        false,
        correlationId,
      );
      return;
    }

    // Contesto del turno (fuori dal prefisso): memorie pertinenti e, se Jev indica una skill guidata, la sua procedura.
    const contextBlocks: string[] = [];
    if (decision.needsMemory && this.deps.memories && this.deps.memories.retrievalLimit > 0) {
      try {
        const hits = await this.deps.memories.repo.search({
          userId: this.auth.userId,
          query: text,
          limit: this.deps.memories.retrievalLimit,
        });
        const block = formatRetrievedMemories(hits);
        if (block) contextBlocks.push(block);
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'recupero memorie fallito',
        );
      }
    }
    const guided =
      (attachments.length ? skills?.guided('documenti') : undefined) ??
      (decision.skillId ? skills?.guided(decision.skillId) : undefined);
    if (guided)
      contextBlocks.push(
        `Procedura «${guided.description}» (usa solo: ${guided.allowedTools.join(', ')}):\n${guided.instructions}`,
      );
    const interruptedNote = this.takeInterruptedNote();
    if (interruptedNote) contextBlocks.push(interruptedNote);
    const memoryContext = contextBlocks.length ? contextBlocks.join('\n\n') : undefined;

    const ac = new AbortController();
    this.activeTurns.set(correlationId, ac);
    const run = this.deps.runTurn ?? defaultRunTurn;
    this.remember('utente', text);
    const turnStartedAt = Date.now();
    const sessionTainted = await this.deps.store.isTainted(sessionId);
    const run_ = new RunContext(this.auth.userId, this.auth.scopes, decision.riskSignal);
    if (sessionTainted) run_.markUntrusted('session:history');
    const taintTtl = this.deps.tools?.taintTtlSeconds ?? 1800;
    this.deps.tools?.setToolContext(sessionId, {
      userId: this.auth.userId,
      sessionId,
      requestId: correlationId,
      scopes: this.auth.scopes,
      run: run_,
      emit: (type, payload) => this.send(type, payload, correlationId),
      signal: ac.signal,
      onTainted: (source) => {
        void this.deps.store.markTainted(sessionId, source, taintTtl).catch(() => {});
      },
    });
    const clearToolContext = () => {
      // Solo se il contesto corrente è ancora di questo turno: un turno successivo potrebbe averlo già sostituito.
      this.deps.tools?.setToolContext(sessionId, null);
    };
    // Il turno gira in background così `user.cancel` e `tool.confirmation.respond` possono essere gestiti nel frattempo.
    void run({
      userId: this.auth.userId,
      sessionId,
      correlationId,
      text,
      inputMode: event.payload.inputMode,
      companion,
      ...(memoryContext ? { memoryContext } : {}),
      decision: {
        route: decision.route === 'skill' ? 'llm' : decision.route,
        modelClass: companion.profile.modelClass,
        source: decision.source,
        costUsd: decision.costUsd,
        inputTokens: decision.inputTokens,
      },
      abortSignal: ac.signal,
      recorder: this.deps.recorder,
      logger: this.deps.logger,
      emit: (type, payload) => {
        if (type === 'assistant.text.completed')
          this.remember('assistente', String((payload as { text: string }).text));
        return this.send(type, payload, correlationId);
      },
    })
      .then(async (res) => {
        if (this.activeTurns.get(correlationId) === ac) clearToolContext();
        const r = res as
          | {
              text?: string;
              cancelled?: boolean;
              loopDetected?: boolean;
              costUsd?: number;
              llmCalls?: number;
              toolCalls?: number;
              latencyMs?: number;
            }
          | undefined;
        if (r?.cancelled) this.noteInterruption(correlationId, r.text ?? '');
        this.spokenThrough.delete(correlationId);
        if (!this.deps.memories) return;
        const outcome = r?.loopDetected ? 'loop' : r?.cancelled ? 'cancelled' : 'completed';
        await this.deps.memories.afterTurn({
          userId: this.auth.userId,
          sessionId,
          requestId: correlationId,
          userText: text,
          route: decision.route,
          modelClass: companion.profile.modelClass,
          model: companion.profile.modelId,
          outcome,
          costUsd: r?.costUsd ?? 0,
          llmCalls: r?.llmCalls ?? 0,
          toolCalls: r?.toolCalls ?? 0,
          latencyMs: r?.latencyMs ?? Date.now() - turnStartedAt,
        });
      })
      .catch(async (err) => {
        if (this.activeTurns.get(correlationId) === ac) clearToolContext();
        this.deps.logger.error({ err, correlationId }, 'runTurn ha rigettato');
        await this.sendError('turn_failed', 'Il turno non è stato completato', true, correlationId);
      })
      .finally(() => {
        this.activeTurns.delete(correlationId);
        void this.deps.store.touch(this.auth.userId, sessionId).catch(() => {});
      });
  }

  /** Risposta locale (comando o skill deterministica): tre eventi, nessuna chiamata a modelli. */
  /** Esegue il percorso deterministico dei documenti e risponde con le schede; false se non c'era nulla da fare. */
  private async runDocumentsFlow(
    run: () => Promise<{ text: string; blocks: readonly ContentBlock[] } | null>,
    correlationId: string,
    t0: number,
    userText: string,
  ): Promise<boolean> {
    const sessionId = this.sessionId;
    if (!sessionId) return false;
    await this.send(
      'assistant.started',
      { route: 'skill', modelClass: this.session?.modelClass ?? 'standard' },
      correlationId,
    );
    try {
      const reply = await run();
      if (!reply) return false;
      await this.deps.decisions.record(
        this.auth.userId,
        sessionId,
        correlationId,
        localDecision(
          'skill',
          this.session?.modelClass ?? 'standard',
          Date.now() - t0,
          'documenti',
        ),
      );
      let n = 0;
      for (const block of reply.blocks)
        await this.send(
          'assistant.block',
          { blockId: `${correlationId}:${n++}`, block },
          correlationId,
        );
      await this.send('assistant.text.completed', { text: reply.text }, correlationId);
      await this.send(
        'assistant.completed',
        {
          finishReason: 'stop',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            llmCalls: 0,
            toolCalls: reply.blocks.length,
            latencyMs: Date.now() - t0,
          },
        },
        correlationId,
      );
      await this.deps.memories?.afterTurn({
        userId: this.auth.userId,
        sessionId,
        requestId: correlationId,
        userText,
        route: 'skill',
        modelClass: this.session?.modelClass ?? 'standard',
        outcome: 'completed',
        costUsd: 0,
        llmCalls: 0,
        toolCalls: reply.blocks.length,
        latencyMs: Date.now() - t0,
      });
      return true;
    } catch (err) {
      this.deps.logger.warn({ err }, 'percorso documenti fallito');
      await this.sendError(
        'document_failed',
        `Non sono riuscito a leggere il documento: ${err instanceof Error ? err.message : String(err)}`,
        true,
        correlationId,
      );
      return true;
    }
  }

  private async replyLocally(
    route: 'deterministic' | 'skill',
    reply: string,
    correlationId: string,
    t0: number,
    userText: string,
    blocks: readonly ContentBlock[] = [],
  ): Promise<void> {
    await this.send(
      'assistant.started',
      { route, modelClass: this.session?.modelClass ?? 'standard' },
      correlationId,
    );
    let n = 0;
    for (const block of blocks)
      await this.send(
        'assistant.block',
        { blockId: `${correlationId}:${n++}`, block },
        correlationId,
      );
    await this.send('assistant.text.completed', { text: reply }, correlationId);
    await this.send(
      'assistant.completed',
      {
        finishReason: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          llmCalls: 0,
          toolCalls: 0,
          latencyMs: Date.now() - t0,
          costUsdActual: 0,
          route,
        },
      },
      correlationId,
    );
    this.remember('utente', userText);
    this.remember('assistente', reply);
  }

  private async spentToday(): Promise<number> {
    try {
      return (await this.deps.budget.assertWithinBudget(this.auth.userId, 0)).spentUsd;
    } catch {
      return 0;
    }
  }

  /**
   * Barge-in (M8): la risposta interrotta non è stata sentita per intero. Si registra fin dove l'utente l'ha sentita
   * (`spokenThroughIndex` del `user.cancel`, altrimenti nulla) così il turno successivo lo sa; nello state del router
   * la risposta compare come interrotta.
   */
  private noteInterruption(correlationId: string, text: string): void {
    const idx = this.spokenThrough.get(correlationId);
    const cut = Math.max(0, Math.min(text.length, idx ?? 0));
    const heard = text.slice(0, cut).trim();
    const unheard = text.slice(cut).trim();
    this.interruptedReply = { heard, unheard };
    this.remember('assistente', `${heard || '(nulla)'} [interrotta dall'utente]`);
  }

  /** Nota per il turno successivo sulla risposta interrotta; si consuma una volta sola. */
  private takeInterruptedNote(): string | undefined {
    const r = this.interruptedReply;
    this.interruptedReply = undefined;
    if (!r || (!r.heard && !r.unheard)) return undefined;
    const heard = r.heard
      ? `ha sentito solo: «${r.heard.slice(-600)}»`
      : 'non ne ha sentita nessuna parte';
    return `Nota: l'utente ha interrotto la tua risposta precedente (${heard}). Non ripetere ciò che ha già sentito; se chiede di continuare, riprendi da dove ti ha fermato.`;
  }

  private remember(role: 'utente' | 'assistente', text: string): void {
    this.recentTurns.push(`${role}: ${text.slice(0, 200)}`);
    if (this.recentTurns.length > 6) this.recentTurns.shift();
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
      const sessionId = this.sessionId ?? NULL_UUID;
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
    return this.send('error', { code, message, retryable }, correlationId ?? NULL_UUID, false);
  }
}
