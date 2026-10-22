import { randomUUID } from 'node:crypto';
import { type ApprovalStore, argsHash, RunContext } from '@ernie/agent-core';
import type { Logger } from '@ernie/observability';
import type { ToolCallRecorder, ToolRegistry } from '@ernie/tools';
import type { Redis } from 'ioredis';
import { publishUserEvent } from './notify.js';
import type { AutomationRepository } from './repository.js';
import type { AutomationRun, PendingAction, RunOutcome } from './schema.js';

export interface DeferredApprovalDeps {
  readonly repo: AutomationRepository;
  readonly approvals: ApprovalStore;
  readonly registry: ToolRegistry;
  readonly audit: ToolCallRecorder;
  readonly logger: Logger;
  readonly redis?: Pick<Redis, 'publish'>;
}

export type DeferredResolution =
  | { readonly outcome: 'not_found' }
  | {
      readonly outcome: 'approved' | 'denied' | 'expired';
      readonly run: AutomationRun | null;
      readonly executed: boolean;
      readonly result?: unknown;
    };

/**
 * Decisione dell'utente su un'azione sospesa da una run headless: l'approvazione viene consumata
 * (monouso, legata a tool e argomenti) e il tool eseguito con gli stessi argomenti; l'esito finisce
 * nell'outcome della run, che passa a `succeeded` quando non restano azioni indecise.
 */
export async function resolveDeferredApproval(
  deps: DeferredApprovalDeps,
  userId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
): Promise<DeferredResolution> {
  const run = await deps.repo.findRunByApproval(userId, approvalId);
  const resolved = await deps.approvals.resolve(
    userId,
    approvalId,
    decision === 'approve' ? 'approved' : 'denied',
  );
  if (resolved === 'not_found') return { outcome: 'not_found' };
  if (!run) return { outcome: resolved, run: null, executed: false };
  const action = run.outcome?.pendingActions?.find((p) => p.approvalId === approvalId);
  let executed = false;
  let result: unknown;

  if (resolved === 'approved' && action) {
    const spec = deps.registry.get(action.toolId);
    const consumed = spec
      ? await deps.approvals.consume(userId, approvalId, action.toolId, action.args)
      : false;
    if (!spec) result = { error: 'tool non più disponibile' };
    else if (!consumed)
      result = { error: 'approvazione non consumabile (scaduta o argomenti diversi)' };
    else {
      const t0 = Date.now();
      const toolCallId = randomUUID();
      const base = {
        userId,
        sessionId: run.sessionId,
        requestId: run.id,
        toolCallId,
        toolId: spec.id,
        toolVersion: spec.version,
        category: spec.category,
        argsHash: argsHash(action.args),
        argsPreview: JSON.stringify(action.args).slice(0, 200),
        taintedBefore: false,
        verdict: 'ask' as const,
        approvalId,
        approved: true,
      };
      try {
        const input = spec.inputSchema.parse(action.args);
        const raw = await spec.execute(input, {
          userId,
          sessionId: run.sessionId,
          requestId: run.id,
          scopes: [],
          run: new RunContext(userId, [], 0),
        });
        result = spec.outputSchema.parse(raw);
        executed = true;
        await deps.audit.record({
          ...base,
          ok: true,
          error: null,
          durationMs: Date.now() - t0,
          taintedAfter: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { error: message.slice(0, 300) };
        await deps.audit.record({
          ...base,
          ok: false,
          error: message.slice(0, 500),
          durationMs: Date.now() - t0,
          taintedAfter: false,
        });
      }
    }
  }

  const pendingActions: PendingAction[] = (run.outcome?.pendingActions ?? []).map((p) =>
    p.approvalId === approvalId
      ? { ...p, decision: resolved, executed, ...(result === undefined ? {} : { result }) }
      : p,
  );
  const allDecided = pendingActions.every((p) => p.decision !== undefined);
  const outcome: RunOutcome = { ...(run.outcome ?? { summary: '' }), pendingActions };
  const updated = await deps.repo.updateRunOutcome(
    userId,
    run.id,
    outcome,
    allDecided ? 'succeeded' : undefined,
  );
  const finalActions = updated?.outcome?.pendingActions ?? pendingActions;
  const finallyDecided =
    finalActions.length > 0 && finalActions.every((p) => p.decision !== undefined);
  if (deps.redis && finallyDecided) {
    await publishUserEvent(deps.redis, {
      userId,
      type: 'automation.run.updated',
      payload: {
        automationId: run.automationId,
        runId: run.id,
        status: 'succeeded',
        summary: `Azioni decise: ${finalActions.filter((p) => p.executed).length} eseguite su ${finalActions.length}`,
      },
    }).catch((err: unknown) => deps.logger.warn({ err }, 'pubblicazione evento fallita'));
  }
  return { outcome: resolved, run: updated, executed, ...(result === undefined ? {} : { result }) };
}
