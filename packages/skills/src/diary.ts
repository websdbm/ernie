import { type Pool, withUser } from '@ernie/db';
import type { DeterministicSkill, SkillReply } from './types.js';
import { addDays, localParts, zonedToUtc } from './zoned.js';

/**
 * Skill «Cosa ho fatto» (M9 A2, idea presa da Muffin): «cosa hai fatto oggi?», «ieri», «questa settimana».
 * Risposta deterministica dai registri di Ernie (liste, ricette, documenti, ricerche, promemoria,
 * automazioni, ricordi nuovi, conferme in sospeso, spesa dei modelli): nessun modello, nessun costo,
 * e nulla che Ernie non abbia davvero registrato.
 */
export type DiaryRange = 'today' | 'yesterday' | 'week';

export interface ActivitySummary {
  readonly shoppingAdded: readonly { name: string; list: string }[];
  readonly shoppingBought: readonly { name: string; list: string }[];
  readonly recipes: readonly { title: string; version: number; created: boolean }[];
  readonly documents: readonly { title: string }[];
  readonly webSearches: readonly string[];
  readonly webPages: readonly string[];
  readonly remindersFired: readonly { text: string; at: Date }[];
  readonly remindersCreated: readonly { text: string; at: Date; forLabel?: string }[];
  readonly automations: readonly { title: string; status: string; at: Date }[];
  readonly memories: readonly string[];
  readonly blocked: readonly { toolId: string; reason: string }[];
  readonly pendingApprovals: number;
  /** Messaggi mandati di mia iniziativa (gate della proattività), per motivo. */
  readonly proactive?: readonly string[];
  readonly llm: { readonly calls: number; readonly costUsd: number };
}

export interface ActivityStore {
  summary(userId: string, from: Date, to: Date): Promise<ActivitySummary>;
}

export const DIARY_RE =
  /^(?:ernie[,\s]+)?(?:cosa|che cosa|cos['’])\s*(?:hai|avete)\s+fatto(?:\s+(?:per\s+me|tu))?(?:\s+(?<when>oggi|ieri|questa\s+settimana|in\s+settimana|negli\s+ultimi\s+(?:7|sette)\s+giorni))?\s*\??$|^(?:riepilogo|resoconto|diario)(?:\s+(?:di|della|del))?\s*(?<when2>oggi|ieri|settimana|questa\s+settimana)?\s*\??$/iu;

export function parseDiaryRequest(text: string): { range: DiaryRange } | null {
  const m = DIARY_RE.exec(text.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const when = (m.groups?.when ?? m.groups?.when2 ?? 'oggi').toLowerCase();
  if (when === 'ieri') return { range: 'yesterday' };
  if (/settimana|giorni/.test(when)) return { range: 'week' };
  return { range: 'today' };
}

/** Intervallo [from, to) nel fuso dell'utente. */
export function diaryWindow(range: DiaryRange, now: Date, tz: string): { from: Date; to: Date } {
  const p = localParts(now, tz);
  const startOf = (days: number) => {
    const [y, mo, d] = addDays(p.year, p.month, p.day, days);
    return zonedToUtc(tz, y, mo, d, 0, 0);
  };
  if (range === 'yesterday') return { from: startOf(-1), to: startOf(0) };
  if (range === 'week') return { from: startOf(-6), to: now };
  return { from: startOf(0), to: now };
}

const RANGE_LABEL: Record<DiaryRange, string> = {
  today: 'Oggi',
  yesterday: 'Ieri',
  week: 'Negli ultimi 7 giorni',
};

const list = (xs: readonly string[], max = 6): string => {
  const uniq = [...new Set(xs)];
  const shown = uniq.slice(0, max).join(', ');
  return uniq.length > max ? `${shown} e altri ${uniq.length - max}` : shown;
};

const byList = (xs: readonly { name: string; list: string }[]): string => {
  const groups = new Map<string, string[]>();
  for (const x of xs) groups.set(x.list, [...(groups.get(x.list) ?? []), x.name]);
  return [...groups.entries()].map(([l, names]) => `${list(names)} («${l}»)`).join('; ');
};

const usd = (v: number) => `${v.toFixed(v < 0.1 ? 3 : 2).replace('.', ',')} $`;

/** Testo del diario: puro e testabile. */
export function formatDiary(
  range: DiaryRange,
  s: ActivitySummary,
  tz: string,
  now = new Date(),
): string {
  const time = (d: Date) => {
    const p = localParts(d, tz);
    const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    if (range !== 'week') return hm;
    const q = localParts(now, tz);
    return p.day === q.day && p.month === q.month ? `oggi ${hm}` : `${p.day}/${p.month} ${hm}`;
  };
  const lines: string[] = [];
  if (s.shoppingAdded.length) lines.push(`- **Liste**: aggiunto ${byList(s.shoppingAdded)}`);
  if (s.shoppingBought.length) lines.push(`- **Spunte**: preso ${byList(s.shoppingBought)}`);
  if (s.recipes.length)
    lines.push(
      `- **Ricette**: ${s.recipes
        .map((r) =>
          r.created ? `salvata «${r.title}»` : `aggiornata «${r.title}» (v${r.version})`,
        )
        .join(', ')}`,
    );
  if (s.documents.length)
    lines.push(
      `- **Documenti**: ${list(
        s.documents.map((d) => `«${d.title}»`),
        5,
      )}`,
    );
  if (s.webSearches.length || s.webPages.length) {
    const parts: string[] = [];
    if (s.webSearches.length)
      parts.push(
        `${s.webSearches.length} ${s.webSearches.length === 1 ? 'ricerca' : 'ricerche'} (${list(s.webSearches, 4)})`,
      );
    if (s.webPages.length)
      parts.push(
        `${s.webPages.length} ${s.webPages.length === 1 ? 'pagina letta' : 'pagine lette'}`,
      );
    lines.push(`- **Web**: ${parts.join(', ')}`);
  }
  if (s.remindersFired.length)
    lines.push(
      `- **Promemoria suonati**: ${s.remindersFired.map((r) => `«${r.text}» alle ${time(r.at)}`).join(', ')}`,
    );
  if (s.remindersCreated.length)
    lines.push(
      `- **Promemoria messi**: ${s.remindersCreated
        .map((r) => `«${r.text}»${r.forLabel ? ` per ${r.forLabel}` : ''} (${time(r.at)})`)
        .join(', ')}`,
    );
  if (s.automations.length) {
    const label: Record<string, string> = {
      succeeded: 'eseguita',
      failed: 'fallita',
      budget_exceeded: 'fermata dal budget',
      awaiting_approval: 'in attesa della tua approvazione',
      silent: 'controllata, niente da segnalare',
      skipped: 'saltata',
    };
    lines.push(
      `- **Automazioni**: ${s.automations
        .map((a) => `«${a.title}» ${label[a.status] ?? a.status} alle ${time(a.at)}`)
        .join(', ')}`,
    );
  }
  if (s.memories.length)
    lines.push(
      `- **Ho imparato**: ${s.memories.slice(0, 4).join(' · ')}${s.memories.length > 4 ? ` (e altre ${s.memories.length - 4})` : ''}`,
    );
  if (s.blocked.length)
    lines.push(
      `- **Fermato per sicurezza**: ${s.blocked
        .slice(0, 3)
        .map((b) => `${b.toolId} (${b.reason})`)
        .join(', ')}`,
    );
  if (s.proactive?.length) {
    const reason: Record<string, string> = {
      approval_expiring: 'una conferma in scadenza',
      family_reminder: 'un promemoria da un familiare',
    };
    lines.push(
      `- **Di mia iniziativa**: ti ho scritto ${s.proactive.length} ${s.proactive.length === 1 ? 'volta' : 'volte'} (${list(
        s.proactive.map((k) => reason[k] ?? k),
        3,
      )})`,
    );
  }
  if (s.pendingApprovals)
    lines.push(
      `- **Aspetta la tua conferma**: ${s.pendingApprovals} ${s.pendingApprovals === 1 ? 'azione' : 'azioni'}`,
    );

  const head = RANGE_LABEL[range];
  if (lines.length === 0)
    return s.llm.calls
      ? `${head} abbiamo solo chiacchierato: nessuna lista, ricetta, documento o promemoria. Spesa dei modelli: ${usd(s.llm.costUsd)}.`
      : `${head} non ho fatto nulla per te: nessuna attività registrata.`;
  const cost = s.llm.calls
    ? `Spesa dei modelli: ${usd(s.llm.costUsd)} (${s.llm.calls} ${s.llm.calls === 1 ? 'chiamata' : 'chiamate'}).`
    : 'Nessuna chiamata ai modelli: tutto senza costi.';
  return `${head} per te:\n\n${lines.join('\n')}\n\n${cost}`;
}

export function createDiarySkill(
  store: ActivityStore | null,
  timezone = 'Europe/Rome',
  now: () => Date = () => new Date(),
): DeterministicSkill {
  return {
    id: 'diario',
    kind: 'deterministic',
    category: 'diary',
    description:
      'Resoconto di ciò che Ernie ha fatto per te (liste, ricette, documenti, ricerche, promemoria, automazioni, ricordi nuovi, spesa): «cosa hai fatto oggi?», «ieri», «questa settimana».',
    examples: ['cosa hai fatto oggi?', 'cosa hai fatto ieri?', 'riepilogo della settimana'],
    match: (text) => parseDiaryRequest(text),
    async run(plan, ctx): Promise<SkillReply> {
      const { range } = plan as { range: DiaryRange };
      if (!store) return { text: 'Il diario non è disponibile su questo server.', actions: [] };
      const t = now();
      const { from, to } = diaryWindow(range, t, timezone);
      const summary = await store.summary(ctx.userId, from, to);
      return { text: formatDiary(range, summary, timezone, t), actions: [`diario:${range}`] };
    },
  };
}

// ---------- archivio Postgres (sola lettura, RLS per utente) ----------

const firstJsonString = (preview: string | null, key: string): string | null => {
  if (!preview) return null;
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(preview);
  return m?.[1] ? m[1].replace(/\\"/g, '"').slice(0, 80) : null;
};

export function createPgActivityStore(pool: Pool): ActivityStore {
  return {
    summary(userId, from, to) {
      return withUser(pool, userId, async (c) => {
        // Un client = una query alla volta: pg non ammette query concorrenti sulla stessa connessione,
        // quindi le richieste passano in fila (Promise.all resta solo per leggibilità).
        let chain: Promise<unknown> = Promise.resolve();
        const serial = <T>(run: () => Promise<T>): Promise<T> => {
          const next = chain.then(run);
          chain = next.catch(() => undefined);
          return next;
        };
        const q = <T extends object>(sql: string, params: unknown[] = []) =>
          serial(() => c.query<T>(sql, [from, to, ...params]).then((r) => r.rows));
        const [
          added,
          bought,
          recipes,
          documents,
          tools,
          fired,
          created,
          runs,
          memories,
          pending,
          llm,
          proactive,
        ] = await Promise.all([
          q<{ name: string; list: string }>(
            `SELECT i.name, l.name AS list FROM shopping_items i JOIN shopping_lists l ON l.id = i.list_id
                WHERE i.added_at >= $1 AND i.added_at < $2 ORDER BY i.added_at LIMIT 60`,
          ),
          q<{ name: string; list: string }>(
            `SELECT i.name, l.name AS list FROM shopping_items i JOIN shopping_lists l ON l.id = i.list_id
                WHERE i.bought_at >= $1 AND i.bought_at < $2 ORDER BY i.bought_at LIMIT 60`,
          ),
          q<{ title: string; version: number; created: boolean }>(
            `SELECT title, version, created_at >= $1 AS created FROM recipes
                WHERE status = 'active' AND updated_at >= $1 AND updated_at < $2 ORDER BY updated_at LIMIT 20`,
          ),
          q<{ title: string }>(
            `SELECT title FROM documents WHERE status <> 'deleted'
                AND ((created_at >= $1 AND created_at < $2) OR (updated_at >= $1 AND updated_at < $2))
                ORDER BY updated_at LIMIT 20`,
          ),
          q<{
            tool_id: string;
            args_preview: string | null;
            verdict: string;
            approved: boolean | null;
            ok: boolean;
            error: string | null;
          }>(
            `SELECT tool_id, args_preview, verdict, approved, ok, error FROM tool_calls
                WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 400`,
          ),
          q<{ title: string; finished_at: Date }>(
            `SELECT a.title, r.finished_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id
                WHERE a.key LIKE 'promemoria\\_%' AND r.status = 'succeeded'
                  AND r.finished_at >= $1 AND r.finished_at < $2 ORDER BY r.finished_at LIMIT 30`,
          ),
          q<{ title: string; at: string; to_label: string | null }>(
            `SELECT title, trigger->>'at' AS at, meta->>'toLabel' AS to_label FROM automations
                WHERE key LIKE 'promemoria\\_%' AND created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 30`,
          ),
          q<{ title: string; status: string; finished_at: Date }>(
            `SELECT a.title, CASE WHEN (r.outcome->>'silent') = 'true' THEN 'silent' ELSE r.status END AS status, r.finished_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id
                WHERE a.key NOT LIKE 'promemoria\\_%' AND r.status <> 'skipped'
                  AND r.finished_at >= $1 AND r.finished_at < $2 ORDER BY r.finished_at LIMIT 30`,
          ),
          q<{ content: string }>(
            `SELECT content FROM memories WHERE kind = 'semantic' AND status = 'active'
                AND created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT 12`,
          ),
          serial(() =>
            c
              .query<{ n: string }>(
                `SELECT count(*)::text AS n FROM tool_approvals WHERE status = 'pending' AND expires_at > now()`,
              )
              .then((r) => r.rows),
          ),
          q<{ calls: string; cost: string | null }>(
            `SELECT count(*)::text AS calls, sum(coalesce(cost_reported_usd, cost_estimated_usd))::text AS cost
                 FROM llm_calls WHERE created_at >= $1 AND created_at < $2`,
          ),
          q<{ kind: string }>(
            `SELECT kind FROM proactive_messages WHERE status = 'sent' AND sent_at >= $1 AND sent_at < $2
              ORDER BY sent_at LIMIT 20`,
          ),
        ]);
        const reminderText = (title: string) =>
          title.replace(/^Promemoria(?: da [^:]+)?:\s*/u, '').slice(0, 80);
        const ok = tools.filter((t) => t.ok);
        return {
          shoppingAdded: added,
          shoppingBought: bought,
          recipes,
          documents,
          webSearches: ok
            .filter((t) => t.tool_id === 'web_search')
            .map((t) => firstJsonString(t.args_preview, 'query'))
            .filter((x): x is string => !!x),
          webPages: ok
            .filter((t) => t.tool_id === 'web_fetch')
            .map((t) => firstJsonString(t.args_preview, 'url'))
            .filter((x): x is string => !!x),
          remindersFired: fired.map((r) => ({ text: reminderText(r.title), at: r.finished_at })),
          remindersCreated: created.map((r) => ({
            text: reminderText(r.title),
            at: new Date(r.at),
            ...(r.to_label ? { forLabel: r.to_label } : {}),
          })),
          automations: runs.map((r) => ({ title: r.title, status: r.status, at: r.finished_at })),
          memories: memories.map((m) => m.content),
          blocked: tools
            .filter(
              (t) =>
                !t.ok && (t.verdict === 'deny' || (t.verdict === 'ask' && t.approved === false)),
            )
            .map((t) => ({
              toolId: t.tool_id,
              reason: (t.error ?? 'non autorizzato').slice(0, 80),
            })),
          pendingApprovals: Number(pending[0]?.n ?? 0),
          proactive: proactive.map((p) => p.kind),
          llm: { calls: Number(llm[0]?.calls ?? 0), costUsd: Number(llm[0]?.cost ?? 0) },
        };
      });
    },
  };
}
