import { type Pool, type PoolClient, withUser } from '@ernie/db';
import { z } from 'zod';

export const UsageQuery = z
  .object({
    period: z.enum(['day', 'week', 'month', 'year']).default('month'),
    date: z.iso.date().optional(),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          const zone = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions()
            .timeZone;
          // Gli offset ISO hanno segno opposto nelle zone POSIX di PostgreSQL.
          // Usiamo nomi IANA canonici anche per alias come CET/GMT.
          return !/^[+-]/.test(zone);
        } catch {
          return false;
        }
      })
      .transform(
        (value) => new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone,
      )
      .default('Europe/Rome'),
    accountId: z.uuid().optional(),
  })
  .strict();
export type UsageQuery = z.infer<typeof UsageQuery>;

export interface UsageTotals {
  amountUsd: number;
  reportedUsd: number;
  estimatedUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
export interface UsageBreakdown {
  id: string;
  label: string;
  amountUsd: number;
  calls: number;
}
export interface UsageAccount {
  id: string;
  name: string;
  companionName: string;
  deleted: boolean;
}
export interface ProviderAccount {
  provider: 'openrouter';
  status: 'available' | 'unavailable' | 'not_configured';
  checkedAt: string;
  balanceUsd?: number;
  totalCreditsUsd?: number;
  totalUsageUsd?: number;
}
export interface UsageReport {
  currency: 'USD';
  timezone: string;
  period: UsageQuery['period'];
  from: string;
  to: string;
  generatedAt: string;
  scope: 'personal' | 'all' | 'account';
  totals: UsageTotals;
  series: { date: string; amountUsd: number; calls: number }[];
  byModel: UsageBreakdown[];
  byActivity: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  coverage: { since: string | null; historicalMayBeIncomplete: true; note: string };
  adminAvailable: boolean;
  accounts?: (UsageAccount & { amountUsd: number; calls: number })[];
  account?: UsageAccount;
  providerAccount?: ProviderAccount;
}

const failure = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code });

/** Solo la concessione amministrativa dedicata abilita i consumi degli altri account. */
async function canAdmin(client: PoolClient, userId: string): Promise<boolean> {
  return (
    (await client.query('SELECT 1 FROM usage_admins WHERE user_id = $1', [userId])).rowCount === 1
  );
}

export function currentUsageDate(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (name: string) => parts.find((p) => p.type === name)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function usageModelLabel(id: string): string {
  const known: Record<string, string> = {
    'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5',
    'anthropic/claude-sonnet-5.5': 'Claude Sonnet 5.5',
    'anthropic/claude-opus-5.5': 'Claude Opus 5.5',
    'google/gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
    'fish-audio/drama-3': 'Drama 3',
  };
  if (id.startsWith('typesafe/jev')) return 'Jev';
  return known[id] ?? id.split('/').at(-1) ?? id;
}

const activityLabels: Record<string, string> = {
  turn: 'Conversazioni',
  memory: 'Memoria e Second Brain',
  summary: 'Riassunti della conversazione',
  router: 'Comprensione delle richieste',
  document: 'Documenti e immagini',
  skill: 'Altre funzioni',
  automation: 'Attività automatiche',
  voice: 'Voce',
  video: 'Video YouTube',
  other: 'Altre attività',
};
const providerLabels: Record<string, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
};

// Tutte le aggregazioni usano lo stesso snapshot SQL. I bucket orari sono intervalli
// assoluti: il giorno del cambio d'ora contiene correttamente 23 o 25 ore.
const REPORT_SQL = `
WITH eligible_accounts AS MATERIALIZED (
  SELECT * FROM usage_accounts
   WHERE NOT $5::boolean OR (installation_seen_at IS NOT NULL AND NOT is_test)
), bounds AS (
  SELECT date_trunc($1::text, $2::date::timestamp) AS local_start,
         CASE $1::text WHEN 'day' THEN interval '1 day'
                      WHEN 'week' THEN interval '1 week'
                      WHEN 'month' THEN interval '1 month'
                      ELSE interval '1 year' END AS span
), period AS (
  SELECT local_start AT TIME ZONE $3 AS start_at,
         (local_start + span) AT TIME ZONE $3 AS end_at,
         local_start, span FROM bounds
), starts AS (
  SELECT tick AS at
    FROM period, LATERAL generate_series(start_at, end_at, interval '1 hour') tick
   WHERE $1 = 'day'
  UNION ALL
  SELECT tick AT TIME ZONE $3 AS at
    FROM period, LATERAL generate_series(local_start, local_start + span,
         CASE WHEN $1 = 'year' THEN interval '1 month' ELSE interval '1 day' END) tick
   WHERE $1 <> 'day'
  UNION
  SELECT end_at FROM period
), buckets AS (
  SELECT at, lead(at) OVER (ORDER BY at) AS until FROM starts
), filtered AS MATERIALIZED (
  SELECT l.*, COALESCE(reported_usd, estimated_usd) AS amount,
         CASE WHEN model LIKE 'fish-audio/%' THEN 'voice'
              WHEN model = 'google/gemini-3.5-flash-lite' AND purpose = 'skill' THEN 'video'
              ELSE purpose END AS activity
    FROM usage_ledger l JOIN eligible_accounts a ON a.user_id = l.user_id, period
   WHERE ($4::uuid IS NULL OR l.user_id = $4)
     AND l.created_at >= start_at AND l.created_at < end_at
), model_totals AS (
  SELECT model AS id, sum(amount) AS amount, count(*) AS calls FROM filtered GROUP BY model
), activity_totals AS (
  SELECT activity AS id, sum(amount) AS amount, count(*) AS calls FROM filtered GROUP BY activity
), provider_totals AS (
  SELECT provider AS id, sum(amount) AS amount, count(*) AS calls FROM filtered GROUP BY provider
), account_totals AS (
  SELECT a.user_id AS id, a.display_name AS name, a.companion_name AS companion,
         a.deleted, COALESCE(sum(f.amount),0) AS amount, count(f.id) AS calls
    FROM eligible_accounts a LEFT JOIN filtered f ON f.user_id = a.user_id
   WHERE ($4::uuid IS NULL OR a.user_id = $4)
   GROUP BY a.user_id, a.display_name, a.companion_name, a.deleted
  HAVING NOT a.deleted OR count(f.id) > 0 OR $4::uuid IS NOT NULL
), series_totals AS (
  SELECT b.at, COALESCE(sum(f.amount),0) AS amount, count(f.id) AS calls
    FROM buckets b LEFT JOIN filtered f ON f.created_at >= b.at AND f.created_at < b.until
   WHERE b.until IS NOT NULL GROUP BY b.at
)
SELECT start_at, end_at,
  (SELECT min(l.created_at) FROM usage_ledger l JOIN eligible_accounts a ON a.user_id = l.user_id
    WHERE ($4::uuid IS NULL OR l.user_id = $4)) AS since,
  (SELECT jsonb_build_object(
    'amountUsd',COALESCE(sum(amount),0),
    'reportedUsd',COALESCE(sum(reported_usd),0),
    'estimatedUsd',COALESCE(sum(CASE WHEN reported_usd IS NULL THEN estimated_usd ELSE 0 END),0),
    'calls',count(*),'inputTokens',COALESCE(sum(input_tokens),0),
    'outputTokens',COALESCE(sum(output_tokens),0)) FROM filtered) AS totals,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('date',at,'amountUsd',amount,'calls',calls)
                           ORDER BY at),'[]') FROM series_totals) AS series,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'amountUsd',amount,'calls',calls)
                           ORDER BY amount DESC,id),'[]') FROM model_totals) AS models,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'amountUsd',amount,'calls',calls)
                           ORDER BY amount DESC,id),'[]') FROM activity_totals) AS activities,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'amountUsd',amount,'calls',calls)
                           ORDER BY amount DESC,id),'[]') FROM provider_totals) AS providers,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',name,'companionName',companion,
                            'deleted',deleted,'amountUsd',amount,'calls',calls)
                           ORDER BY amount DESC,name,id),'[]') FROM account_totals) AS accounts
FROM period`;

interface ReportRow {
  start_at: Date;
  end_at: Date;
  since: Date | null;
  totals: UsageTotals;
  series: UsageReport['series'];
  models: Omit<UsageBreakdown, 'label'>[];
  activities: Omit<UsageBreakdown, 'label'>[];
  providers: Omit<UsageBreakdown, 'label'>[];
  accounts: NonNullable<UsageReport['accounts']>;
}

export function createUsageService(pool: Pool, now: () => Date = () => new Date()) {
  return {
    canAdmin: (userId: string) => withUser(pool, userId, (c) => canAdmin(c, userId)),
    async report(userId: string, query: UsageQuery, administrative = false): Promise<UsageReport> {
      if (!administrative && query.accountId)
        throw failure(400, 'invalid_query', 'Il pannello personale mostra solo il tuo account.');
      const generatedAt = now();
      const date = query.date ?? currentUsageDate(query.timezone, generatedAt);
      if (date < '2000-01-01' || date > '2100-12-31')
        throw failure(400, 'invalid_query', 'Scegli una data tra il 2000 e il 2100.');
      return withUser(pool, userId, async (c) => {
        const admin = await canAdmin(c, userId);
        if (administrative && !admin)
          throw failure(403, 'forbidden', 'Non hai accesso ai consumi delle altre installazioni.');
        const target = administrative ? (query.accountId ?? null) : userId;
        const row = (
          await c.query<ReportRow>(REPORT_SQL, [
            query.period,
            date,
            query.timezone,
            target,
            administrative,
          ])
        ).rows[0];
        if (!row) throw new Error('riepilogo consumi non disponibile');
        if (target && row.accounts.length === 0)
          throw failure(404, 'not_found', 'Account non trovato.');
        const scope = administrative ? (target ? 'account' : 'all') : 'personal';
        return {
          currency: 'USD',
          timezone: query.timezone,
          period: query.period,
          from: row.start_at.toISOString(),
          to: row.end_at.toISOString(),
          generatedAt: generatedAt.toISOString(),
          scope,
          totals: row.totals,
          series: row.series.map((bucket) => ({
            ...bucket,
            date: new Date(bucket.date).toISOString(),
          })),
          byModel: row.models.map((x) => ({ ...x, label: usageModelLabel(x.id) })),
          byActivity: row.activities.map((x) => ({
            ...x,
            label: activityLabels[x.id] ?? 'Altre attività',
          })),
          byProvider: row.providers.map((x) => ({
            ...x,
            label: providerLabels[x.id] ?? x.id,
          })),
          coverage: {
            since: row.since?.toISOString() ?? null,
            historicalMayBeIncomplete: true,
            note:
              'Importi in dollari USA. Usiamo il costo comunicato dal servizio AI; quando manca, una stima. Una richiesta a Ernie può richiedere più chiamate AI. I dispositivi dello stesso account condividono i consumi.' +
              (administrative
                ? ' Il riepilogo include solo account con un’installazione dell’app Ernie; gli account tecnici e di collaudo sono esclusi.'
                : ''),
          },
          adminAvailable: admin,
          ...(scope === 'all' ? { accounts: row.accounts } : {}),
          ...(scope === 'account' && row.accounts[0] ? { account: row.accounts[0] } : {}),
        };
      });
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;

/** Saldo del servizio condiviso, separato dai totali Ernie. Nessuna chiamata LLM. */
export function createProviderBalance(
  apiKey: string | undefined,
  doFetch: typeof fetch = fetch,
  now: () => Date = () => new Date(),
) {
  let cached: ProviderAccount | undefined;
  let pending: Promise<ProviderAccount> | undefined;
  const load = async (): Promise<ProviderAccount> => {
    const checkedAt = now().toISOString();
    if (!apiKey) return { provider: 'openrouter', status: 'not_configured', checkedAt };
    try {
      const response = await doFetch('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error('saldo non disponibile');
      const result = z
        .object({
          data: z.object({
            total_credits: z.number().finite().nonnegative(),
            total_usage: z.number().finite().nonnegative(),
          }),
        })
        .parse(await response.json());
      return {
        provider: 'openrouter',
        status: 'available',
        checkedAt,
        balanceUsd: result.data.total_credits - result.data.total_usage,
        totalCreditsUsd: result.data.total_credits,
        totalUsageUsd: result.data.total_usage,
      };
    } catch {
      return { provider: 'openrouter', status: 'unavailable', checkedAt };
    }
  };
  return async (): Promise<ProviderAccount> => {
    if (cached && now().getTime() - new Date(cached.checkedAt).getTime() < 60_000) return cached;
    if (pending) return pending;
    pending = load();
    try {
      cached = await pending;
      return cached;
    } finally {
      pending = undefined;
    }
  };
}
