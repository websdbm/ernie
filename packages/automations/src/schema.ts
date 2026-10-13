import { z } from 'zod';

export const CronTrigger = z.object({
  type: z.literal('cron'),
  pattern: z.string().min(9).max(100),
});
export const OnceTrigger = z.object({ type: z.literal('once'), at: z.iso.datetime() });
export const WebhookTrigger = z.object({ type: z.literal('webhook') });
export const EventTrigger = z.object({
  type: z.literal('event'),
  eventName: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/),
});
export const Trigger = z.discriminatedUnion('type', [
  CronTrigger,
  OnceTrigger,
  WebhookTrigger,
  EventTrigger,
]);
export type Trigger = z.infer<typeof Trigger>;

export const DeterministicAction = z.object({
  type: z.literal('skill'),
  skillId: z.string().min(1),
  /** Frase da passare alla skill deterministica (es. "cosa c'è nella lista?"). */
  input: z.string().min(1).max(500),
});
export const GuidedAction = z.object({
  type: z.literal('guided'),
  /** Prompt autosufficiente: la run parte in una sessione nuova, senza cronologia. */
  instructions: z.string().min(10).max(4000),
  allowedTools: z.array(z.string()).max(20).default([]),
  modelClass: z.enum(['standard', 'heavy']).default('standard'),
  contextTags: z.array(z.string()).max(10).default([]),
});
export type DeterministicAction = z.infer<typeof DeterministicAction>;
export type GuidedAction = z.infer<typeof GuidedAction>;
export const Action = z.discriminatedUnion('type', [DeterministicAction, GuidedAction]);
export type Action = z.infer<typeof Action>;

/**
 * Controllo economico prima del modello (ricerca 11, C5): insieme CHIUSO, mai script dell'utente.
 * Se la fonte non cambia la run finisce senza chiamare il modello; un errore della fonte è un errore.
 */
export const PageChangedCheck = z.object({ type: z.literal('page_changed'), url: z.url() });
export const FeedNewItemsCheck = z.object({ type: z.literal('feed_new_items'), url: z.url() });
export const Check = z.discriminatedUnion('type', [PageChangedCheck, FeedNewItemsCheck]);
export type Check = z.infer<typeof Check>;

export const NotifyPolicy = z.enum(['always', 'if_condition', 'never']);
export type NotifyPolicy = z.infer<typeof NotifyPolicy>;

export const AutomationInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  title: z.string().min(1).max(120),
  trigger: Trigger,
  action: Action,
  timezone: z.string().min(1).max(64).default('Europe/Rome'),
  budgetUsd: z.number().min(0).max(5).default(0.05),
  catchUp: z.enum(['none', 'latest']).default('none'),
  jitterSeconds: z.number().int().min(0).max(900).default(0),
  notify: z.boolean().default(true),
  /** Ricerca 11, C4: «if_condition» = la run avvisa solo se `condition` è vera (sentinelle). */
  notifyPolicy: NotifyPolicy.default('always'),
  condition: z.string().min(3).max(300).optional(),
  check: Check.optional(),
  enabled: z.boolean().default(true),
  /** Metadati liberi (es. promemoria da un familiare: chi lo ha messo e con quale etichetta). */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

export const RunStatus = z.enum([
  'scheduled',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'budget_exceeded',
  'awaiting_approval',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export interface Automation {
  readonly id: string;
  readonly userId: string;
  readonly key: string;
  readonly title: string;
  readonly kind: 'deterministic' | 'guided';
  readonly trigger: Trigger;
  readonly timezone: string;
  readonly action: Action;
  readonly budgetUsd: number;
  readonly catchUp: 'none' | 'latest';
  readonly jitterSeconds: number;
  readonly notify: boolean;
  readonly notifyPolicy: NotifyPolicy;
  readonly condition: string | null;
  readonly check: Check | null;
  readonly checkState: Readonly<Record<string, unknown>> | null;
  readonly enabled: boolean;
  readonly version: number;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly webhookSecret: string | null;
  /** Esecuzioni fallite di fila (azzerate da un successo o dalla ripresa). */
  readonly consecutiveFailures: number;
  /** Motivo della pausa automatica; null se l'automazione non è in pausa. */
  readonly pausedReason: string | null;
  readonly pausedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly userId: string;
  readonly scheduledAt: Date;
  readonly dedupeKey: string;
  readonly triggerType: string;
  readonly triggerPayload: unknown;
  readonly status: RunStatus;
  readonly outcome: RunOutcome | null;
  readonly error: string | null;
  readonly costUsd: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly attempt: number;
  readonly sessionId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

export interface Notification {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export const AUTOMATION_QUEUE = 'automations';

/** Job `tick`: emesso dal job scheduler BullMQ per i cron; il worker calcola l'istante pianificato e accoda una `run`. */
export interface TickJobData {
  readonly automationId: string;
  readonly userId: string;
}

/** Job `run`: un'esecuzione; `dedupeKey` è la chiave di idempotenza (anche come jobId BullMQ). */
export interface RunJobData {
  readonly automationId: string;
  readonly userId: string;
  readonly scheduledAt: string;
  readonly dedupeKey: string;
  readonly triggerType: Trigger['type'] | 'manual';
  /** Payload esterno (webhook/evento): non fidato, entra nel prompt come dati e contamina la run. */
  readonly payload?: unknown;
  /** Anti-ricorsione: una run non può crearne altre (depth > 0 viene rifiutato). */
  readonly depth: number;
}

/** Esito strutturato di una run, distinto dal successo infrastrutturale. */
export interface RunOutcome {
  readonly summary: string;
  readonly data?: unknown;
  /** Ricerca 11, C4: controllato senza avvisare (condizione falsa o nessun cambiamento). */
  readonly silent?: boolean;
  /** Azioni sospese in attesa dell'approvazione dell'utente (azioni sensibili in run headless). */
  readonly pendingActions?: readonly PendingAction[];
}
export interface PendingAction {
  readonly approvalId: string;
  readonly toolId: string;
  readonly args: unknown;
  readonly reason: string;
  readonly expiresAt: string;
  readonly decision?: 'approved' | 'denied' | 'expired';
  readonly executed?: boolean;
  readonly result?: unknown;
}
