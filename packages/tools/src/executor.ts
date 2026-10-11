import { randomUUID } from 'node:crypto';
import {
  type ApprovalStore,
  argsHash,
  evaluateToolPolicy,
  type PendingApprovals,
  type PolicyRules,
  type ToolPolicyDescriptor,
} from '@ernie/agent-core';
import type { Logger } from '@ernie/observability';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolCallRecorder } from './audit.js';
import { type ToolContext, ToolError, type ToolSpec } from './types.js';

export interface ExecutorDeps {
  readonly policyRules: PolicyRules;
  readonly approvals?: {
    readonly store: ApprovalStore;
    readonly pending: PendingApprovals;
    readonly ttlMs: number;
    /**
     * `interactive` (default): attende la risposta dell'utente connesso.
     * `deferred` (run headless, es. automazioni): l'azione non viene eseguita, l'approvazione resta
     * pendente e viene segnalata a `onDeferred`; il modello riceve `approval_pending`.
     */
    readonly mode?: 'interactive' | 'deferred';
    readonly onDeferred?: (action: DeferredAction) => void;
  };
  readonly audit: ToolCallRecorder;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  /** Tetto in caratteri del risultato serializzato restituito al modello. */
  readonly maxResultChars?: number;
}

/** Riferimento mutabile al contesto del turno: il set di tool resta fisso per sessione, il contesto cambia per turno. */
export interface ToolContextRef {
  current: ToolContext | null;
}

/** Azione sensibile sospesa in una run headless: eseguita dopo l'approvazione dell'utente (stessi argomenti). */
export interface DeferredAction {
  readonly approvalId: string;
  readonly toolId: string;
  readonly args: unknown;
  readonly reason: string;
  readonly expiresAt: string;
}

export const ToolErrorResult = z.object({
  error: z.string(),
  reason: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type ToolErrorResult = z.infer<typeof ToolErrorResult>;

function preview(v: unknown, max = 200): string | null {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return null;
  }
}

function truncateResult(value: unknown, maxChars: number): unknown {
  const s = JSON.stringify(value);
  if (s.length <= maxChars) return value;
  // Tronca le stringhe più lunghe mantenendo la struttura.
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length > 2_000 ? `${v.slice(0, 2_000)}… [troncato]` : v;
    if (Array.isArray(v)) return v.slice(0, 20).map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    return v;
  };
  return walk(value);
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(`timeout dopo ${ms} ms`, 'timeout', true)), ms);
    signal?.addEventListener('abort', () => reject(new ToolError('annullato', 'aborted', false)), {
      once: true,
    });
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Avvolge un ToolSpec in un tool Mastra con: policy deny → ask → allow, approvazione monouso,
 * timeout e retry sugli errori transitori, taint dopo contenuti non fidati, audit per chiamata,
 * tetto sulla dimensione del risultato. Gli errori tornano al modello come `{ error }`, mai come eccezioni.
 */
export function createGuardedTool(spec: ToolSpec, deps: ExecutorDeps, ctxRef: ToolContextRef) {
  const descriptor: ToolPolicyDescriptor = {
    id: spec.id,
    risk: spec.risk,
    ...(spec.requiredScopes ? { requiredScopes: spec.requiredScopes } : {}),
  };
  const maxChars = deps.maxResultChars ?? 8_000;

  return createTool({
    id: spec.id,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: z.union([spec.outputSchema, ToolErrorResult]),
    execute: async (input: unknown, execCtx?: { abortSignal?: AbortSignal }) => {
      const ctx = ctxRef.current;
      if (!ctx)
        return { error: 'no_context', reason: 'nessun turno attivo' } satisfies ToolErrorResult;
      const t0 = Date.now();
      const toolCallId = randomUUID();
      const hash = argsHash(input);
      const taintedBefore = ctx.run.tainted;
      const base = {
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        toolCallId,
        toolId: spec.id,
        toolVersion: spec.version,
        category: spec.category,
        argsHash: hash,
        argsPreview: preview(input),
        taintedBefore,
      };

      // 1) Policy deterministica, fuori dal modello.
      const verdict = evaluateToolPolicy(descriptor, ctx.run.toPolicyContext(), deps.policyRules);
      let approvalId: string | null = null;
      let approved: boolean | null = null;
      if (verdict.kind === 'deny') {
        await deps.audit.record({
          ...base,
          verdict: 'deny',
          approvalId,
          approved,
          ok: false,
          error: verdict.reason,
          durationMs: Date.now() - t0,
          taintedAfter: ctx.run.tainted,
        });
        return { error: 'denied', reason: verdict.reason } satisfies ToolErrorResult;
      }
      if (verdict.kind === 'ask') {
        if (!deps.approvals) {
          await deps.audit.record({
            ...base,
            verdict: 'ask',
            approvalId,
            approved: false,
            ok: false,
            error: 'conferme non disponibili',
            durationMs: Date.now() - t0,
            taintedAfter: ctx.run.tainted,
          });
          return {
            error: 'denied',
            reason: `serve conferma: ${verdict.reason}`,
          } satisfies ToolErrorResult;
        }
        const created = await deps.approvals.store.create({
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          requestId: ctx.requestId,
          toolCallId,
          toolId: spec.id,
          args: input,
          reason: verdict.reason,
          ttlMs: deps.approvals.ttlMs,
        });
        approvalId = created.id;
        await ctx.emit?.('tool.confirmation.requested', {
          approvalId: created.id,
          toolCallId,
          toolId: spec.id,
          displayName: spec.description.slice(0, 120),
          ...(preview(input) ? { argsPreview: preview(input) as string } : {}),
          reason: verdict.reason.slice(0, 300),
          expiresAt: created.expiresAt.toISOString(),
        });
        if (deps.approvals.mode === 'deferred') {
          deps.approvals.onDeferred?.({
            approvalId: created.id,
            toolId: spec.id,
            args: input,
            reason: verdict.reason,
            expiresAt: created.expiresAt.toISOString(),
          });
          await deps.audit.record({
            ...base,
            verdict: 'ask',
            approvalId,
            approved: null,
            ok: false,
            error: 'sospesa: in attesa di approvazione differita',
            durationMs: Date.now() - t0,
            taintedAfter: ctx.run.tainted,
          });
          return {
            error: 'approval_pending',
            reason: `azione sospesa in attesa dell'approvazione dell'utente (${verdict.reason}); non ripeterla e prosegui con il resto`,
          } satisfies ToolErrorResult;
        }
        const decision = await deps.approvals.pending.wait(
          created.id,
          deps.approvals.ttlMs,
          ctx.signal,
        );
        approved =
          decision === 'approved' &&
          (await deps.approvals.store.consume(ctx.userId, created.id, spec.id, input));
        if (!approved) {
          await deps.audit.record({
            ...base,
            verdict: 'ask',
            approvalId,
            approved: false,
            ok: false,
            error: `non autorizzato (${decision})`,
            durationMs: Date.now() - t0,
            taintedAfter: ctx.run.tainted,
          });
          return {
            error: decision === 'expired' ? 'approval_expired' : 'denied_by_user',
            reason: verdict.reason,
          } satisfies ToolErrorResult;
        }
      }

      // 2) Esecuzione con timeout e retry sui soli errori transitori.
      const attempts = Math.max(1, spec.retry?.attempts ?? 1);
      const timeoutMs = spec.timeoutMs ?? 15_000;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const signal = ctx.signal ?? execCtx?.abortSignal;
          const raw = await withTimeout(spec.execute(input, ctx), timeoutMs, signal);
          const parsed = spec.outputSchema.safeParse(raw);
          if (!parsed.success)
            throw new ToolError(
              `output non conforme: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
              'bad_output',
            );
          const source = spec.risk.ingestsUntrusted
            ? (spec.untrustedSource?.(input, parsed.data) ?? spec.id)
            : null;
          if (source) {
            ctx.run.markUntrusted(source);
            ctx.onTainted?.(source);
          }
          await deps.audit.record({
            ...base,
            verdict: verdict.kind,
            approvalId,
            approved,
            ok: true,
            error: null,
            durationMs: Date.now() - t0,
            taintedAfter: ctx.run.tainted,
          });
          return truncateResult(parsed.data, maxChars);
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof ToolError ? err.retryable : false;
          if (!retryable || attempt === attempts) break;
          await new Promise((r) => setTimeout(r, (spec.retry?.backoffMs ?? 500) * attempt));
        }
      }
      const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
      deps.logger.warn({ toolId: spec.id, requestId: ctx.requestId, err: message }, 'tool fallito');
      await deps.audit.record({
        ...base,
        verdict: verdict.kind,
        approvalId,
        approved,
        ok: false,
        error: message.slice(0, 500),
        durationMs: Date.now() - t0,
        taintedAfter: ctx.run.tainted,
      });
      return {
        error: lastErr instanceof ToolError ? lastErr.code : 'tool_failed',
        reason: message.slice(0, 300),
        retryable: lastErr instanceof ToolError ? lastErr.retryable : false,
      } satisfies ToolErrorResult;
    },
  });
}

/** Costruisce la mappa di tool Mastra (nome → tool) per una sessione, con un unico contesto condiviso. */
export function buildSessionTools(
  specs: readonly ToolSpec[],
  deps: ExecutorDeps,
  ctxRef: ToolContextRef,
) {
  return Object.fromEntries(specs.map((s) => [s.id, createGuardedTool(s, deps, ctxRef)]));
}
