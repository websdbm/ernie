import { randomUUID } from 'node:crypto';
import {
  type ApprovalStore,
  type CompanionAgent,
  runTurn as defaultRunTurn,
  type EmotionInput,
  inferEmotion,
  type PendingApprovals,
  RunContext,
  routeCommand,
  type TurnInput,
} from '@ernie/agent-core';
import {
  type Clarification,
  type ClarifyInput,
  clarificationNote,
  type DecisionRouter,
  type RouteDecision,
  type SkillCheckInput,
  type SkillCheckResult,
} from '@ernie/jev-router';
import {
  formatMemoryNotices,
  formatProfileNotices,
  formatRetrievedMemories,
  type MemoryRepository,
  type ProfileStore,
} from '@ernie/memory';
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
import {
  type DeterministicSkill,
  formatFiredIntents,
  type IntentStore,
  type SkillRegistry,
} from '@ernie/skills';
import type { ToolContextRef, ToolRuleStore } from '@ernie/tools';
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { type ClarificationRecord, interpretationBlock, isCorrection } from '../clarify.js';
import { formatDeviceContext } from '../device-context.js';
import { type DocumentsFlow, parseDocumentRequest, parseSchemaCommand } from '../documents-flow.js';
import type { RouterDecisionRecorder } from '../router/recorder.js';
import { SessionForbiddenError, type SessionRecord, type SessionStore } from '../sessions/store.js';

/** Ora e posizione del telefono per i tool (es. note del second brain annotate «qui»). */
function toolDevice(d: NonNullable<ClientEventOf<'user.message'>['payload']['device']>) {
  return {
    ...(d.timezone ? { timezone: d.timezone } : {}),
    ...(d.location
      ? {
          location: {
            latitude: d.location.latitude,
            longitude: d.location.longitude,
            ...(d.location.place ? { place: d.location.place } : {}),
          },
        }
      : {}),
  };
}

type ClientEventOf<T extends ClientEvent['type']> = Extract<ClientEvent, { type: T }>;

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
  /**
   * Chiarimento interno (15 ott 2026): se Jev giudica il messaggio poco chiaro o l'utente corregge la risposta
   * precedente, un modello leggero fa domande chiuse sul testo e Jev risponde; la nota entra nel contesto del turno.
   */
  readonly clarify?: {
    readonly run: (
      ctx: { userId: string; sessionId: string; requestId: string },
      input: ClarifyInput,
    ) => Promise<Clarification | null>;
    readonly known: (userId: string) => Promise<{ people: string[]; places: string[] }>;
    readonly record?: (r: ClarificationRecord) => Promise<void>;
    readonly thresholds: { readonly ambiguity: number; readonly correction: number };
  };
  /**
   * Controllo dei comandi rapidi (15 ott 2026): prima di eseguire senza modello un'azione riconosciuta da una skill,
   * Jev confronta quello che la skill ha capito con la frase; se non è fedele, decide il modello con gli strumenti.
   */
  readonly skillCheck?: {
    readonly run: (input: SkillCheckInput) => Promise<SkillCheckResult | null>;
    readonly threshold: number;
    readonly record?: (r: ClarificationRecord) => Promise<void>;
  };
  /** Ricerca 11, S2: scheda «Fonti» con le pagine citate e verificate a fine turno. */
  readonly citations?: (requestId: string, text: string) => ContentBlock | null;
  /** Ricerca 11, S1: promemoria a evento che scattano sulle parole del messaggio (senza modello). */
  readonly intents?: Pick<IntentStore, 'fire'>;
  /** Ricerca 11, C4: esiti silenziosi delle sentinelle, letti una volta dal turno successivo. */
  readonly silentRuns?: (
    userId: string,
  ) => Promise<Array<{ title: string; summary: string; at: Date }>>;
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
  /** Scheda anagrafica: i cambiamenti emersi in chat si comunicano una volta, al turno dopo. */
  readonly profiles?: ProfileStore;
  /** Second brain (B2): nota pertinente da accennare in una riga, senza modello; null se non c'è. */
  readonly brainSuggest?: (
    userId: string,
    text: string,
    exclude: readonly string[],
  ) => Promise<{ path: string; title: string; when: string; passage: string } | null>;
  /** Sezione salute: avvisi dopo un nuovo referto (blocco per il contesto), detti una volta. */
  readonly healthNotices?: (userId: string) => Promise<string | null>;
  /** Second brain (B2): proposta di travaso dalla memoria (blocco per il contesto), al più una per conversazione. */
  readonly brainTransfer?: (userId: string) => Promise<string | null>;
  /**
   * Turni risolti senza modello (skill deterministiche, comandi): salvati nella cronologia della sessione sul
   * server, così il registro del controllo genitori è completo e l'agente ne sa qualcosa nei turni dopo.
   */
  readonly recordLocalTurn?: (
    userId: string,
    sessionId: string,
    userText: string,
    reply: string,
    route: 'deterministic' | 'skill',
  ) => Promise<void>;
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
/** Domande semplici di fila dopo le quali una sessione heavy torna standard (la seconda risponde già standard). */
const SIMPLE_TURNS_TO_LOWER = 2;

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
  /** Note del second brain già accennate in questa conversazione (una volta per nota). */
  private readonly brainSuggested = new Set<string>();
  /** La proposta di travaso si valuta una volta per conversazione. */
  private brainTransferChecked = false;
  /** Domanda di una skill in attesa di risposta nel messaggio successivo (es. «a che ora?»), 10 minuti. */
  private pendingFollowUp: { skillId: string; awaiting: unknown; until: number } | null = null;
  /** Barge-in: fino a quale carattere l'utente ha sentito la risposta che ha interrotto (per correlationId). */
  private readonly spokenThrough = new Map<string, number>();
  /** Ultima risposta interrotta dall'utente: ciò che ha sentito e ciò che non ha sentito (per il turno successivo). */
  private interruptedReply: { heard: string; unheard: string } | undefined;
  /** Ultimi scambi (max 6 righe) per lo state del router: non persistiti. */
  private readonly recentTurns: string[] = [];
  /** Domande di fila che Jev giudica semplici: alla seconda una sessione heavy torna standard. */
  private simpleStreak = 0;
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

  /**
   * Discesa della classe (richiesta dell'utente, 16 ott 2026). La sessione sale a heavy con la prima richiesta
   * complessa e prima ci restava fino alla fine: Opus con ragionamento scriveva la prima parola dopo 3–9 s e costava
   * circa cinque volte tanto anche per «e quanto ci vuole?». Ora alla seconda domanda semplice di fila (Jev vuole
   * `standard` con sicurezza, senza ragionamento esteso) la sessione torna standard, e quella domanda risponde già
   * standard. Non scende se heavy l'ha scelto l'utente con «/classe heavy».
   */
  private async settleModelClass(
    decision: RouteDecision,
    sessionId: string,
  ): Promise<RouteDecision> {
    if (!this.session) return decision;
    if (decision.requestedModelClass === 'heavy') this.simpleStreak = 0;
    if (decision.requestedModelClass !== 'standard') return decision;
    this.simpleStreak++;
    if (this.session.modelClass !== 'heavy' || this.simpleStreak < SIMPLE_TURNS_TO_LOWER)
      return decision;
    if (await this.deps.store.isModelClassPinned(sessionId)) return decision;
    const effective = await this.deps.store.lowerModelClass(this.auth.userId, sessionId);
    this.session = { ...this.session, modelClass: effective };
    this.deps.invalidateCompanion(sessionId);
    this.deps.logger.info(
      { sessionId, simpleTurns: this.simpleStreak },
      'sessione riportata a standard',
    );
    return { ...decision, modelClass: effective === 'heavy' ? 'heavy' : 'standard' };
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
    // Tetto di spesa: il titolare può alzarlo o toglierlo (0); per gli altri account vale al massimo quello del
    // server, che un valore personale può solo abbassare (revisione del 16 ott 2026: un account seguito poteva
    // mettere 0, cioè nessun limite).
    const own = this.auth.settings.dailyBudgetUsd;
    const budget =
      this.auth.role === 'owner'
        ? typeof own === 'number'
          ? own
          : this.deps.dailyBudgetUsd
        : typeof own === 'number' && own > 0
          ? Math.min(own, this.deps.dailyBudgetUsd)
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
        const effective =
          command.modelClass === 'heavy'
            ? await this.deps.store.raiseModelClass(this.auth.userId, sessionId, 'heavy')
            : await this.deps.store.lowerModelClass(this.auth.userId, sessionId);
        await this.deps.store.pinModelClass(sessionId, command.modelClass === 'heavy');
        this.simpleStreak = 0;
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
    // Risposta a una domanda della skill nel turno prima («alle 9» dopo «a che ora?»): vale una volta sola.
    const pending = this.pendingFollowUp;
    this.pendingFollowUp = null;
    let followUpMatch: { skill: DeterministicSkill; plan: unknown } | null = null;
    if (pending && pending.until > Date.now() && attachments.length === 0 && skills) {
      const skill = skills.get(pending.skillId);
      if (skill?.kind === 'deterministic' && skill.followUp) {
        const plan = skill.followUp(pending.awaiting, text);
        if (plan) followUpMatch = { skill, plan };
      }
    }
    let match = followUpMatch ?? (attachments.length === 0 ? (skills?.match(text) ?? null) : null);
    // Il comando rapido ha capito tutta la frase? Se no, la richiesta passa al modello (le risposte a una domanda
    // della skill, «alle 9», sono brevi: non si controllano).
    let skillNote: string | undefined;
    if (match && !followUpMatch) {
      skillNote = await this.checkSkillPlan(
        match,
        text,
        event.payload.inputMode,
        sessionId,
        correlationId,
        event.payload.device?.timezone,
      );
      if (skillNote) match = null;
    }
    // Promemoria a evento: confronto full-text del messaggio, mai sulla frase che ne crea uno.
    const fired =
      this.deps.intents && attachments.length === 0 && match?.skill.id !== 'promemoria_evento'
        ? await this.deps.intents.fire(this.auth.userId, text).catch(() => [])
        : [];
    const firedNote = formatFiredIntents(fired);
    if (match) {
      const loc = event.payload.device?.location;
      const raw = await match.skill.run(match.plan, {
        userId: this.auth.userId,
        sessionId,
        requestId: correlationId,
        ...(loc
          ? {
              device: {
                location: {
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  ...(loc.accuracyM !== undefined ? { accuracyM: loc.accuracyM } : {}),
                  ...(loc.place ? { place: loc.place } : {}),
                },
              },
            }
          : {}),
      });
      const reply = firedNote ? { ...raw, text: `${raw.text}\n\n${firedNote}` } : raw;
      if (raw.awaiting !== undefined)
        this.pendingFollowUp = {
          skillId: match.skill.id,
          awaiting: raw.awaiting,
          until: Date.now() + 10 * 60_000,
        };
      await this.deps.decisions.record(
        this.auth.userId,
        sessionId,
        correlationId,
        localDecision('skill', this.session.modelClass, Date.now() - t0, match.skill.id),
      );
      await this.replyLocally(
        'skill',
        reply.text,
        correlationId,
        t0,
        text,
        reply.blocks,
        reply.actions,
      );
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
    const decision = await this.settleModelClass(
      await this.deps.router.decide({
        text: modelText,
        inputMode: event.payload.inputMode,
        recentTurns: this.recentTurns,
        toolCategories: this.deps.tools?.categories ?? [],
        skillCandidates: skills?.candidates(text) ?? [],
        sessionModelClass: this.session.modelClass,
      }),
      sessionId,
    );
    await this.deps.decisions.record(this.auth.userId, sessionId, correlationId, decision);
    if (decision.modelClass === 'heavy' && this.session.modelClass !== 'heavy') {
      const effective = await this.deps.store.raiseModelClass(this.auth.userId, sessionId, 'heavy');
      this.session = { ...this.session, modelClass: effective };
      this.deps.invalidateCompanion(sessionId);
    }

    const clarifyNote = await this.clarifyTurn(
      modelText,
      event.payload.inputMode,
      decision,
      sessionId,
      correlationId,
    );

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
    // v1.10: ora locale e posizione del telefono (solo se l'utente ha dato il permesso per la posizione).
    const deviceBlock = formatDeviceContext(event.payload.device);
    if (deviceBlock) contextBlocks.push(deviceBlock);
    // Second brain (B2): una nota pertinente, una volta per conversazione, mai le riservate.
    if (
      this.deps.brainSuggest &&
      attachments.length === 0 &&
      decision.skillId !== 'second_brain' &&
      text.trim().split(/\s+/).length >= 4
    ) {
      try {
        const hit = await this.deps.brainSuggest(this.auth.userId, text, [...this.brainSuggested]);
        if (hit) {
          this.brainSuggested.add(hit.path);
          contextBlocks.push(
            `Nel second brain dell'utente c'è una nota forse pertinente: «${hit.title}» (${hit.when}): ${hit.passage}\nSe aiuta davvero, accennala in una riga (es. «ho una nota su questo, vuoi che la riprenda?») o usala citandola «(nota: ${hit.title})»; se non c'entra, ignorala senza parlarne.`,
          );
        }
      } catch {
        /* suggerimento facoltativo */
      }
    }
    if (
      this.deps.brainTransfer &&
      !this.brainTransferChecked &&
      attachments.length === 0 &&
      decision.skillId !== 'second_brain'
    ) {
      this.brainTransferChecked = true;
      try {
        const block = await this.deps.brainTransfer(this.auth.userId);
        if (block) contextBlocks.push(block);
      } catch {
        /* proposta facoltativa */
      }
    }
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
    // Ricerca 11, M1: cambiamenti della memoria (sostituzioni, dubbi) comunicati una volta al turno dopo.
    if (this.deps.memories) {
      try {
        const notices = await this.deps.memories.repo.pendingNotices(this.auth.userId, 5);
        const block = formatMemoryNotices(notices);
        if (block) {
          contextBlocks.push(block);
          await this.deps.memories.repo.markNotified(
            this.auth.userId,
            notices.map((n) => n.id),
          );
        }
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'avvisi della memoria non letti',
        );
      }
    }
    if (this.deps.profiles) {
      try {
        const notices = await this.deps.profiles.pendingNotices(this.auth.userId, 5);
        const block = formatProfileNotices(notices);
        if (block) {
          contextBlocks.push(block);
          await this.deps.profiles.markNotified(
            this.auth.userId,
            notices.map((n) => n.id),
          );
        }
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'avvisi della scheda non letti',
        );
      }
    }
    if (this.deps.healthNotices) {
      try {
        const block = await this.deps.healthNotices(this.auth.userId);
        if (block) contextBlocks.push(block);
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'avvisi della salute non letti',
        );
      }
    }
    if (firedNote)
      contextBlocks.push(
        `Promemoria a evento appena scattati per quello che l'utente ha detto (riportali in una frase, con naturalezza):\n${firedNote}`,
      );
    if (this.deps.silentRuns) {
      try {
        const runs = await this.deps.silentRuns(this.auth.userId);
        if (runs.length)
          contextBlocks.push(
            `Controlli fatti in silenzio dall'ultima volta (non hai avvisato l'utente perché non serviva; citali solo se chiede):\n${runs
              .map((r) => `- «${r.title}»: ${r.summary.slice(0, 160) || 'nessun cambiamento'}`)
              .join('\n')}`,
          );
      } catch {
        /* contesto facoltativo */
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
    if (clarifyNote) contextBlocks.push(clarifyNote);
    if (skillNote) contextBlocks.push(skillNote);
    // Jev vede una richiesta per una skill che il comando rapido non ha riconosciuto (frase insolita o storpiata).
    const missed =
      !skillNote && decision.route === 'skill' && decision.skillId
        ? skills?.get(decision.skillId)
        : undefined;
    if (missed?.kind === 'deterministic')
      contextBlocks.push(
        `La richiesta sembra per la funzione «${missed.id}» (${missed.description.slice(0, 160)}) anche se non è detta nella forma solita: eseguila con i suoi strumenti, interpretando con buon senso parole storpiate, incomplete o in ordine diverso.`,
      );
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
      ...(event.payload.device ? { device: toolDevice(event.payload.device) } : {}),
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
        const cites =
          !r?.cancelled && r?.text ? this.deps.citations?.(correlationId, r.text) : null;
        if (cites)
          await this.send(
            'assistant.block',
            { blockId: `${correlationId}:fonti`, block: cites },
            correlationId,
          );
        await this.sendEmotion(correlationId, {
          userText: text,
          replyText: r?.text ?? '',
          outcome: r?.loopDetected ? 'loop' : r?.cancelled ? 'cancelled' : 'completed',
        });
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
        await this.sendEmotion(correlationId, { userText: text, replyText: '', outcome: 'error' });
      })
      .finally(() => {
        this.activeTurns.delete(correlationId);
        void this.deps.store.touch(this.auth.userId, sessionId).catch(() => {});
      })
      .catch((err: unknown) =>
        this.deps.logger.error({ err, correlationId }, 'chiusura del turno fallita'),
      );
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
      await this.sendEmotion(correlationId, {
        userText,
        replyText: reply.text,
        outcome: 'completed',
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
    actions?: readonly string[],
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
    const sid = this.sessionId;
    if (sid && this.deps.recordLocalTurn)
      void this.deps
        .recordLocalTurn(this.auth.userId, sid, userText, reply, route)
        .catch((err: unknown) =>
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'turno locale non salvato nella cronologia',
          ),
        );
    await this.sendEmotion(correlationId, {
      userText,
      replyText: reply,
      outcome: 'completed',
      ...(actions ? { actions } : {}),
    });
  }

  /** Espressione dell'avatar dedotta dal turno (M10): regole, nessun modello; nel dubbio non si manda nulla. */
  private async sendEmotion(correlationId: string, input: EmotionInput): Promise<void> {
    const e = inferEmotion(input);
    if (!e) return;
    try {
      await this.send(
        'avatar.emotion',
        { name: e.name, intensity: e.intensity, durationMs: e.durationMs },
        correlationId,
      );
    } catch {
      /* espressione persa: non è un errore del turno */
    }
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

  /**
   * Chiarimento interno: scatta solo se Jev giudica il messaggio poco chiaro o se l'utente corregge la risposta
   * precedente. Manda in chat la riga «Ho inteso …» (solo con interpretazioni sicure) e restituisce la nota per il
   * modello. Qualsiasi errore o ritardo: si risponde senza chiarimento.
   */
  private async clarifyTurn(
    text: string,
    inputMode: 'text' | 'voice',
    decision: RouteDecision,
    sessionId: string,
    correlationId: string,
  ): Promise<string | undefined> {
    const c = this.deps.clarify;
    if (!c) return undefined;
    const correcting = isCorrection(text) || (decision.correction ?? 0) >= c.thresholds.correction;
    const ambiguous = (decision.ambiguity ?? 0) >= c.thresholds.ambiguity;
    if (!correcting && (!ambiguous || decision.route === 'deterministic')) return undefined;
    const trigger = correcting ? 'correction' : 'ambiguous';
    const correctionNote = correcting
      ? 'L’utente sta correggendo la tua risposta precedente: rileggi la sua richiesta alla luce della correzione e non ripetere lo stesso errore.'
      : undefined;
    const base = {
      userId: this.auth.userId,
      sessionId,
      requestId: correlationId,
      message: text,
      trigger,
      ambiguity: decision.ambiguity,
      correction: decision.correction,
    } as const;
    const t0 = Date.now();
    try {
      const known = await c.known(this.auth.userId).catch(() => ({ people: [], places: [] }));
      const result = await c.run(
        { userId: this.auth.userId, sessionId, requestId: correlationId },
        {
          trigger,
          message: text,
          inputMode,
          recentTurns: [...this.recentTurns],
          people: known.people,
          places: known.places,
        },
      );
      void c
        .record?.({ ...base, clarification: result, latencyMs: Date.now() - t0 })
        .catch(() => {});
      if (!result) return correctionNote;
      const block = interpretationBlock(result);
      if (block)
        await this.send(
          'assistant.block',
          { blockId: `${correlationId}:interpretazione`, block },
          correlationId,
        );
      return clarificationNote(result) ?? correctionNote;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn({ err: message, trigger }, 'chiarimento interno non riuscito');
      void c.record?.({ ...base, latencyMs: Date.now() - t0, error: message }).catch(() => {});
      return correctionNote;
    }
  }

  /**
   * Controllo di Jev su un comando rapido: restituisce la nota per il modello se il comando non è fedele alla
   * frase (e allora non va eseguito), altrimenti undefined. Senza Jev, in ritardo o con errori: si esegue.
   */
  private async checkSkillPlan(
    match: { skill: DeterministicSkill; plan: unknown },
    text: string,
    inputMode: 'text' | 'voice',
    sessionId: string,
    correlationId: string,
    timezone?: string,
  ): Promise<string | undefined> {
    const check = this.deps.skillCheck;
    const planned = check && match.skill.describe ? match.skill.describe(match.plan) : null;
    if (!check || !planned) return undefined;
    const base = {
      userId: this.auth.userId,
      sessionId,
      requestId: correlationId,
      message: text,
      trigger: 'skill',
    } as const;
    const t0 = Date.now();
    try {
      const r = await check.run({
        message: text,
        planned,
        inputMode,
        recentTurns: [...this.recentTurns],
        nowLocal: new Intl.DateTimeFormat('it-IT', {
          timeZone: timezone ?? 'Europe/Rome',
          dateStyle: 'full',
          timeStyle: 'short',
        }).format(new Date()),
      });
      void check
        .record?.({
          ...base,
          skill: { id: match.skill.id, planned, ...(r ? { faithful: r.faithful } : {}) },
          latencyMs: r?.latencyMs ?? Date.now() - t0,
          ...(r ? { costUsd: r.costUsd } : {}),
        })
        .catch(() => {});
      if (!r || r.faithful >= check.threshold) return undefined;
      return `Il comando rapido della funzione «${match.skill.id}» aveva capito: ${planned}. Un controllo ha visto che non corrisponde del tutto alla richiesta dell’utente, quindi non è stato eseguito: eseguila tu con gli strumenti, rispettando ogni dettaglio (orari, preavvisi, persone, condizioni, più compiti nella stessa frase). Non parlare di questo controllo.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(
        { err: message, skill: match.skill.id },
        'controllo del comando rapido non riuscito',
      );
      void check
        .record?.({
          ...base,
          skill: { id: match.skill.id, planned },
          latencyMs: Date.now() - t0,
          error: message,
        })
        .catch(() => {});
      return undefined;
    }
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
      // Le espressioni dell'avatar sono effimere: non si rinviano alla ripresa (sostituirebbero quella del momento).
      if (this.sessionId && !type.startsWith('avatar.'))
        await this.deps.store.append(this.sessionId, event);
    });
    this.sending = next.catch((err) => this.deps.logger.warn({ err }, 'invio evento fallito'));
    return next;
  }

  /**
   * Errore al client; non rifiuta mai: se Redis non risponde (numerazione degli eventi) l'errore resta nei log.
   * Prima un breve disservizio di Redis faceva rifiutare anche questo invio, la promessa di `handleRaw` restava
   * non gestita e l'API si chiudeva (revisione del 16 ott 2026).
   */
  private sendError(
    code: string,
    message: string,
    retryable: boolean,
    correlationId?: string,
  ): Promise<void> {
    return this.send(
      'error',
      { code, message, retryable },
      correlationId ?? NULL_UUID,
      false,
    ).catch((err: unknown) => this.deps.logger.warn({ err, code }, 'errore non inviato al client'));
  }
}
