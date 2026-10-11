import { type Pool, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';

export interface ToolCallAudit {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly category: string;
  readonly argsHash: string;
  readonly argsPreview: string | null;
  readonly verdict: 'allow' | 'ask' | 'deny';
  readonly approvalId: string | null;
  readonly approved: boolean | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly durationMs: number;
  readonly taintedBefore: boolean;
  readonly taintedAfter: boolean;
}

export interface ToolCallRecorder {
  record(a: ToolCallAudit): Promise<void>;
}

export function createToolCallRecorder(pool: Pool, logger: Logger): ToolCallRecorder {
  return {
    async record(a) {
      try {
        await withUser(pool, a.userId, (client) =>
          client.query(
            `INSERT INTO tool_calls (user_id, session_id, request_id, tool_call_id, tool_id, tool_version, category, args_hash, args_preview,
               verdict, approval_id, approved, ok, error, duration_ms, tainted_before, tainted_after)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              a.userId,
              a.sessionId,
              a.requestId,
              a.toolCallId,
              a.toolId,
              a.toolVersion,
              a.category,
              a.argsHash,
              a.argsPreview,
              a.verdict,
              a.approvalId,
              a.approved,
              a.ok,
              a.error,
              a.durationMs,
              a.taintedBefore,
              a.taintedAfter,
            ],
          ),
        );
      } catch (err) {
        logger.error({ err, toolId: a.toolId, requestId: a.requestId }, 'audit tool_calls fallito');
      }
    },
  };
}

export const memoryToolCallRecorder = (): ToolCallRecorder & { entries: ToolCallAudit[] } => {
  const entries: ToolCallAudit[] = [];
  return {
    entries,
    async record(a) {
      entries.push(a);
    },
  };
};
