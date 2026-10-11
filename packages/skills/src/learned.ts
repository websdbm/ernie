import { createHash } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';
import type { ToolRegistry } from '@ernie/tools';
import type { GuidedSkill } from './types.js';

export type LearnedStatus =
  | 'draft'
  | 'proposed'
  | 'tested'
  | 'approved'
  | 'active'
  | 'deprecated'
  | 'rejected';

export interface LearnedSkill {
  readonly id: string;
  readonly userId: string | null;
  readonly key: string;
  readonly version: number;
  readonly status: LearnedStatus;
  readonly title: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly allowedTools: readonly string[];
  readonly instructions: string;
  readonly contentHash: string;
  readonly riskClass: 'low' | 'high';
  readonly createdBy: string;
  readonly testReport: Record<string, unknown> | null;
  readonly approvedBy: string | null;
  readonly createdAt: Date;
}

export interface ProposalInput {
  readonly userId: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly triggers?: readonly string[];
  readonly allowedTools: readonly string[];
  readonly instructions: string;
  readonly createdBy: string;
}

export interface TestReport {
  readonly ok: boolean;
  readonly checks: Array<{ name: string; ok: boolean; detail?: string | undefined }>;
}

interface Row {
  id: string;
  user_id: string | null;
  key: string;
  version: number;
  status: LearnedStatus;
  title: string;
  description: string;
  triggers: string[];
  allowed_tools: string[];
  instructions: string;
  content_hash: string;
  risk_class: 'low' | 'high';
  created_by: string;
  test_report: Record<string, unknown> | null;
  approved_by: string | null;
  created_at: Date;
}
const COLS = `id, user_id, key, version, status, title, description, triggers, allowed_tools, instructions, content_hash, risk_class, created_by, test_report, approved_by, created_at`;
const toSkill = (r: Row): LearnedSkill => ({
  id: r.id,
  userId: r.user_id,
  key: r.key,
  version: r.version,
  status: r.status,
  title: r.title,
  description: r.description,
  triggers: r.triggers,
  allowedTools: r.allowed_tools,
  instructions: r.instructions,
  contentHash: r.content_hash,
  riskClass: r.risk_class,
  createdBy: r.created_by,
  testReport: r.test_report,
  approvedBy: r.approved_by,
  createdAt: r.created_at,
});

const FORBIDDEN = [/```/, /\b(eval|exec|spawn|require|import)\s*\(/i, /<script/i];

/**
 * Ciclo di vita delle skill apprese (03-revisione B.2): proposta → test → approvazione → attivazione,
 * versioni immutabili per hash, scansione del contenuto alla scrittura e al recupero, una sola attiva per chiave.
 * Le skill apprese sono guidate (markdown + tool consentiti): niente codice, quindi niente sandbox.
 */
export function createLearnedSkillRepository(pool: Pool, tools: ToolRegistry) {
  function scan(s: Pick<LearnedSkill, 'instructions' | 'allowedTools'>): TestReport {
    const checks: TestReport['checks'] = [];
    checks.push({
      name: 'lunghezza istruzioni',
      ok: s.instructions.length >= 20 && s.instructions.length <= 4_000,
      detail: `${s.instructions.length} caratteri`,
    });
    const bad = FORBIDDEN.filter((re) => re.test(s.instructions));
    checks.push({
      name: 'nessun codice',
      ok: bad.length === 0,
      detail: bad.length ? 'pattern di codice trovati' : undefined,
    });
    const unknown = s.allowedTools.filter((t) => !tools.get(t));
    checks.push({
      name: 'tool esistenti',
      ok: unknown.length === 0,
      detail: unknown.length ? `sconosciuti: ${unknown.join(', ')}` : undefined,
    });
    const risky = s.allowedTools
      .map((t) => tools.get(t))
      .filter((t) => t && (t.risk.externalEffect || t.risk.write)).length;
    checks.push({
      name: 'classe di rischio',
      ok: true,
      detail: risky > 0 ? 'alta (tool con scrittura o effetti esterni)' : 'bassa',
    });
    return { ok: checks.every((c) => c.ok), checks };
  }
  function riskClassOf(allowedTools: readonly string[]): 'low' | 'high' {
    return allowedTools.some((t) => {
      const spec = tools.get(t);
      return spec && (spec.risk.externalEffect || spec.risk.write);
    })
      ? 'high'
      : 'low';
  }
  const hashOf = (s: ProposalInput) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          i: s.instructions,
          t: [...s.allowedTools].sort(),
          g: [...(s.triggers ?? [])].sort(),
        }),
      )
      .digest('hex');

  return {
    scan,
    async propose(input: ProposalInput): Promise<LearnedSkill> {
      const report = scan({ instructions: input.instructions, allowedTools: input.allowedTools });
      if (!report.ok)
        throw new Error(
          `proposta rifiutata: ${report.checks
            .filter((c) => !c.ok)
            .map((c) => `${c.name} (${c.detail ?? ''})`)
            .join('; ')}`,
        );
      return withUser(pool, input.userId, async (client) => {
        const v = await client.query<{ max: number | null }>(
          `SELECT max(version)::int AS max FROM skills WHERE user_id = $1 AND key = $2`,
          [input.userId, input.key],
        );
        const version = (v.rows[0]?.max ?? 0) + 1;
        const res = await client.query<Row>(
          `INSERT INTO skills (user_id, key, kind, version, status, title, description, triggers, allowed_tools, instructions, content_hash, risk_class, created_by)
           VALUES ($1,$2,'guided',$3,'proposed',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
          [
            input.userId,
            input.key,
            version,
            input.title,
            input.description,
            [...(input.triggers ?? [])],
            [...input.allowedTools],
            input.instructions,
            hashOf(input),
            riskClassOf(input.allowedTools),
            input.createdBy,
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error('proposta non salvata');
        return toSkill(row);
      });
    },
    async test(userId: string, id: string): Promise<LearnedSkill> {
      return withUser(pool, userId, async (client) => {
        const cur = await client.query<Row>(
          `SELECT ${COLS} FROM skills WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        const row = cur.rows[0];
        if (!row) throw new Error('skill non trovata');
        if (row.status !== 'proposed')
          throw new Error(`stato non valido per il test: ${row.status}`);
        const report = scan({ instructions: row.instructions, allowedTools: row.allowed_tools });
        const res = await client.query<Row>(
          `UPDATE skills SET status = $3, test_report = $4, tested_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
          [id, userId, report.ok ? 'tested' : 'rejected', JSON.stringify(report)],
        );
        const updated = res.rows[0];
        if (!updated) throw new Error('aggiornamento fallito');
        return toSkill(updated);
      });
    },
    async approve(
      userId: string,
      id: string,
      approvedBy: string,
      asOwner: boolean,
    ): Promise<LearnedSkill> {
      return withUser(pool, userId, async (client) => {
        const cur = await client.query<Row>(
          `SELECT ${COLS} FROM skills WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        const row = cur.rows[0];
        if (!row) throw new Error('skill non trovata');
        if (row.status !== 'tested')
          throw new Error(`stato non valido per l'approvazione: ${row.status}`);
        if (row.risk_class === 'high' && !asOwner)
          throw new Error('skill ad alto rischio: serve un owner');
        const res = await client.query<Row>(
          `UPDATE skills SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
          [id, userId, approvedBy],
        );
        const updated = res.rows[0];
        if (!updated) throw new Error('aggiornamento fallito');
        return toSkill(updated);
      });
    },
    async activate(userId: string, id: string): Promise<LearnedSkill> {
      return withUser(pool, userId, async (client) => {
        const cur = await client.query<Row>(
          `SELECT ${COLS} FROM skills WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        const row = cur.rows[0];
        if (!row) throw new Error('skill non trovata');
        if (row.status !== 'approved')
          throw new Error(`stato non valido per l'attivazione: ${row.status}`);
        await client.query(
          `UPDATE skills SET status = 'deprecated', updated_at = now() WHERE user_id = $1 AND key = $2 AND status = 'active'`,
          [userId, row.key],
        );
        const res = await client.query<Row>(
          `UPDATE skills SET status = 'active', updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
          [id],
        );
        const updated = res.rows[0];
        if (!updated) throw new Error('attivazione fallita');
        return toSkill(updated);
      });
    },
    async reject(userId: string, id: string): Promise<void> {
      await withUser(pool, userId, (client) =>
        client.query(
          `UPDATE skills SET status = 'rejected', updated_at = now() WHERE id = $1 AND user_id = $2 AND status IN ('proposed','tested','approved')`,
          [id, userId],
        ),
      );
    },
    async list(userId: string, status?: LearnedStatus): Promise<LearnedSkill[]> {
      return withUser(pool, userId, async (client) => {
        const res = status
          ? await client.query<Row>(
              `SELECT ${COLS} FROM skills WHERE (user_id = $1 OR user_id IS NULL) AND status = $2 ORDER BY created_at DESC`,
              [userId, status],
            )
          : await client.query<Row>(
              `SELECT ${COLS} FROM skills WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC`,
              [userId],
            );
        return res.rows.map(toSkill);
      });
    },
    /** Skill attive dell'utente come GuidedSkill, scansionate di nuovo al recupero (skill misevolution). */
    async loadActiveGuided(userId: string): Promise<GuidedSkill[]> {
      const active = await this.list(userId, 'active');
      return active
        .filter((s) => scan(s).ok)
        .map((s) => ({
          id: `learned:${s.key}`,
          kind: 'guided',
          category: 'learned',
          description: s.description,
          examples: s.triggers,
          allowedTools: s.allowedTools,
          instructions: s.instructions,
          riskClass: s.riskClass,
        }));
    },
  };
}
export type LearnedSkillRepository = ReturnType<typeof createLearnedSkillRepository>;
