import { type Pool, withUser } from '@ernie/db';
import type { AgentEvent } from '@ernie/protocol';
import { z } from 'zod';

const milliseconds = z.number().int().min(0).max(900_000);
export const PerformanceMetrics = z
  .object({
    firstContentMs: milliseconds.optional(),
    completedMs: milliseconds.optional(),
    firstSpeechMs: milliseconds.optional(),
    speechEndedMs: milliseconds.optional(),
    sttFinalizationMs: milliseconds.optional(),
    audibleMs: milliseconds.optional(),
    contextMs: milliseconds.optional(),
    companionMs: milliseconds.optional(),
    routerMs: milliseconds.optional(),
  })
  .strict();

export const PerformanceObservation = z
  .object({
    sessionId: z.uuid(),
    requestId: z.uuid(),
    source: z.enum(['server', 'ios', 'ios_simulator']),
    appVersion: z.string().max(40),
    inputMode: z.enum(['text', 'voice']),
    outcome: z.enum(['completed', 'error', 'cancelled', 'interrupted', 'abandoned']),
    reconnected: z.boolean(),
    metrics: PerformanceMetrics,
  })
  .strict()
  .superRefine((o, ctx) => {
    const m = o.metrics;
    if (o.outcome === 'completed' && m.completedMs === undefined)
      ctx.addIssue({ code: 'custom', message: 'completedMs richiesto per un turno completato' });
    if (
      m.firstContentMs !== undefined &&
      m.completedMs !== undefined &&
      m.firstContentMs > m.completedMs
    )
      ctx.addIssue({ code: 'custom', message: 'contenuto dopo la fine del testo' });
    if (
      m.firstSpeechMs !== undefined &&
      m.speechEndedMs !== undefined &&
      m.firstSpeechMs > m.speechEndedMs
    )
      ctx.addIssue({ code: 'custom', message: 'inizio voce dopo la fine' });
  });
export type PerformanceObservation = z.infer<typeof PerformanceObservation>;
export type PerformanceMetrics = z.infer<typeof PerformanceMetrics>;

export const ClientPerformanceBatch = z
  .object({
    observations: z
      .array(
        PerformanceObservation.refine((o) => o.source !== 'server', 'origine riservata al server'),
      )
      .min(1)
      .max(20),
  })
  .strict();

/** Rank nearest: coerente con i report del corpus; il numero di campioni è sempre esplicito. */
export function timingSummary(values: readonly number[]) {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).toSorted((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

export function summarizePerformance(observations: readonly PerformanceObservation[]) {
  const groups = new Map<string, PerformanceObservation[]>();
  for (const o of observations) {
    const key = JSON.stringify([o.source, o.inputMode, o.appVersion]);
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.values()].map((rows) => {
    const first = rows[0] as PerformanceObservation;
    const clean = rows.filter((o) => o.outcome === 'completed' && !o.reconnected);
    return {
      source: first.source,
      inputMode: first.inputMode,
      appVersion: first.appVersion,
      total: rows.length,
      completed: rows.filter((o) => o.outcome === 'completed').length,
      errors: rows.filter((o) => o.outcome === 'error').length,
      interrupted: rows.filter((o) => ['cancelled', 'interrupted', 'abandoned'].includes(o.outcome))
        .length,
      reconnected: rows.filter((o) => o.reconnected).length,
      cleanSamples: clean.length,
      timings: Object.fromEntries(
        Object.keys(PerformanceMetrics.shape).map((key) => [
          key,
          timingSummary(
            clean.flatMap((o) => {
              const value = o.metrics[key as keyof PerformanceMetrics];
              return value === undefined ? [] : [value];
            }),
          ),
        ]),
      ),
    };
  });
}

export function createPerformanceStore(pool: Pool) {
  return {
    async record(userId: string, observations: readonly PerformanceObservation[]) {
      const validated = observations.map((o) => PerformanceObservation.parse(o));
      return withUser(pool, userId, async (c) => {
        let accepted = 0;
        for (const o of validated) {
          const session = await c.query('SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2', [
            o.sessionId,
            userId,
          ]);
          if (!session.rowCount)
            throw Object.assign(new Error('Sessione inesistente'), {
              statusCode: 404,
              code: 'not_found',
            });
          const result = await c.query(
            `INSERT INTO performance_observations
              (user_id,session_id,request_id,source,app_version,input_mode,outcome,reconnected,metrics)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
            [
              userId,
              o.sessionId,
              o.requestId,
              o.source,
              o.appVersion,
              o.inputMode,
              o.outcome,
              o.reconnected,
              JSON.stringify(o.metrics),
            ],
          );
          accepted += result.rowCount ?? 0;
        }
        // Scadenza per account; non accumulare permanentemente telemetria tecnica.
        await c.query(
          "DELETE FROM performance_observations WHERE user_id=$1 AND created_at<now()-interval '90 days'",
          [userId],
        );
        return accepted;
      });
    },
    async report(userId: string, days: number) {
      return withUser(pool, userId, async (c) => {
        const result = await c.query<PerformanceObservation>(
          `SELECT session_id AS "sessionId",request_id AS "requestId",source,app_version AS "appVersion",
            input_mode AS "inputMode",outcome,reconnected,metrics FROM performance_observations
           WHERE user_id=$1 AND created_at>=now()-($2::int * interval '1 day') ORDER BY created_at DESC LIMIT 10001`,
          [userId, days],
        );
        return {
          days,
          limited: result.rows.length > 10000,
          groups: summarizePerformance(result.rows.slice(0, 10000)),
        };
      });
    },
  };
}
export type PerformanceStore = ReturnType<typeof createPerformanceStore>;

/** Origine monotona: frame user.message ricevuto; termina con la risposta, prima del lavoro memoria. */
export class ServerTurnTrace {
  private readonly metrics: PerformanceMetrics = {};
  private finished = false;
  private reconnected = false;
  constructor(
    readonly sessionId: string,
    readonly requestId: string,
    private readonly inputMode: 'text' | 'voice',
    private readonly started: number,
    private readonly clock: () => number = () => performance.now(),
  ) {}
  reconnect() {
    this.reconnected = true;
  }
  phase(key: 'contextMs' | 'companionMs' | 'routerMs', value: number) {
    if (!this.finished && Number.isFinite(value) && value >= 0 && value <= 900_000)
      this.metrics[key] = Math.round(value);
  }
  observe(event: AgentEvent): PerformanceObservation | null {
    if (this.finished || event.correlationId !== this.requestId) return null;
    const elapsed = Math.max(0, Math.round(this.clock() - this.started));
    if (elapsed > 900_000) {
      this.finished = true;
      return null;
    }
    const content =
      (event.type === 'assistant.text.delta' && Boolean(event.payload.delta.trim())) ||
      (event.type === 'assistant.text.completed' && Boolean(event.payload.text.trim())) ||
      event.type === 'assistant.block' ||
      event.type === 'tool.confirmation.requested';
    if (content) this.metrics.firstContentMs ??= elapsed;
    const outcome =
      event.type === 'assistant.completed'
        ? event.payload.finishReason === 'error'
          ? 'error'
          : event.payload.finishReason === 'cancelled'
            ? 'cancelled'
            : 'completed'
        : event.type === 'assistant.cancelled'
          ? 'cancelled'
          : event.type === 'error'
            ? 'error'
            : null;
    if (!outcome) return null;
    this.finished = true;
    this.metrics.completedMs = elapsed;
    return {
      sessionId: this.sessionId,
      requestId: this.requestId,
      source: 'server',
      appVersion: 'server',
      inputMode: this.inputMode,
      outcome,
      reconnected: this.reconnected,
      metrics: { ...this.metrics },
    };
  }
}
