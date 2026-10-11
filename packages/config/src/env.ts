import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const postgresUrl = z.url().refine((u) => /^postgres(ql)?:\/\//.test(u), {
  message: 'deve iniziare con postgres:// o postgresql://',
});

const redisUrl = z
  .url()
  .refine((u) => /^rediss?:\/\//.test(u), { message: 'deve iniziare con redis:// o rediss://' });

/**
 * Schema delle variabili d'ambiente riconosciute dal backend.
 * Ogni variabile è documentata in docs/CONFIGURATION.md.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('ernie'),
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: postgresUrl,
  /** URL con il ruolo proprietario, usato solo dalle migrazioni (default: DATABASE_URL). */
  MIGRATIONS_DATABASE_URL: postgresUrl.optional(),
  /** Password del ruolo applicativo `ernie_app`, impostata dalla CLI di migrazione. */
  APP_DB_PASSWORD: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: redisUrl,
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
  /** Origin ammessi sull'upgrade WebSocket (CSV). I client nativi non inviano Origin. */
  WS_ALLOWED_ORIGINS: z.string().default(''),
  /** Tetto di spesa LLM giornaliero per utente, in USD, se non impostato in users.settings. */
  LLM_DAILY_BUDGET_USD: z.coerce.number().min(0).default(2),
  MODEL_LIGHT: z.string().min(1).default('anthropic/claude-haiku-5.5'),
  MODEL_STANDARD: z.string().min(1).default('anthropic/claude-sonnet-5.5'),
  MODEL_HEAVY: z.string().min(1).default('anthropic/claude-opus-5.5'),
  JEV_MODEL: z.string().min(1).default('typesafe/jev-1.13'),
  JEV_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1500),
  ROUTER_CACHE_TTL_S: z.coerce.number().int().min(0).default(600),
  /** File JSON con le soglie del router (vedi infrastructure/router/thresholds.json). */
  ROUTER_THRESHOLDS_FILE: z.string().min(1).default('infrastructure/router/thresholds.json'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  MEMORY_SNAPSHOT_MAX_CHARS: z.coerce.number().int().min(200).max(8000).default(2000),
  MEMORY_RETRIEVAL_LIMIT: z.coerce.number().int().min(0).max(10).default(4),
  MEMORY_CONSOLIDATION_DELAY_S: z.coerce.number().int().min(0).default(20),
  MEMORY_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /** Categorie di tool abilitate per le sessioni (CSV). */
  TOOL_CATEGORIES: z.string().default('utility,memory,shopping_list,web,presentation'),
  TOOL_APPROVAL_TTL_S: z.coerce.number().int().min(10).max(3600).default(120),
  POLICY_RISK_ASK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  WEB_ALLOWED_DOMAINS: z.string().default(''),
  WEB_BLOCKED_DOMAINS: z.string().default(''),
  /** Tetto al budget per run che un utente può assegnare a un'automazione. */
  AUTOMATION_MAX_RUN_BUDGET_USD: z.coerce.number().min(0).max(10).default(0.5),
  /** Validità delle approvazioni differite create dalle automazioni (default 7 giorni). */
  AUTOMATION_APPROVAL_TTL_S: z.coerce
    .number()
    .int()
    .min(60)
    .default(7 * 24 * 3600),
  /** Oltre questo ritardo una run cron con catchUp=none viene saltata. */
  AUTOMATION_CATCHUP_TOLERANCE_S: z.coerce.number().int().min(0).default(900),
  AUTOMATION_SYNC_EVERY_S: z.coerce.number().int().min(5).default(60),
  AUTOMATION_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** APNs (token-based): senza queste variabili le notifiche push non vengono inviate. */
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).default('com.websdbm.ernie'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly service: { readonly name: string; readonly version: string };
  readonly http: { readonly host: string; readonly port: number };
  readonly log: { readonly level: LogLevel };
  readonly db: {
    readonly url: string;
    readonly migrationsUrl: string;
    readonly appPassword: string | undefined;
    readonly poolMax: number;
  };
  readonly redis: { readonly url: string };
  readonly ws: { readonly allowedOrigins: readonly string[] };
  readonly llm: {
    readonly dailyBudgetUsd: number;
    readonly models: { readonly light: string; readonly standard: string; readonly heavy: string };
  };
  readonly memory: {
    readonly embeddingModel: string;
    readonly snapshotMaxChars: number;
    readonly retrievalLimit: number;
    readonly consolidationDelaySeconds: number;
    readonly retentionDays: number;
  };
  readonly tools: {
    readonly categories: readonly string[];
    readonly approvalTtlSeconds: number;
    readonly riskAskThreshold: number;
    readonly webAllowedDomains: readonly string[];
    readonly webBlockedDomains: readonly string[];
  };
  readonly automations: {
    readonly maxRunBudgetUsd: number;
    readonly approvalTtlSeconds: number;
    readonly catchUpToleranceSeconds: number;
    readonly syncEverySeconds: number;
    readonly concurrency: number;
  };
  readonly push: {
    readonly apns: {
      readonly teamId: string;
      readonly keyId: string;
      readonly privateKey: string;
      readonly bundleId: string;
    } | null;
  };
  readonly router: {
    readonly jevModel: string;
    readonly timeoutMs: number;
    readonly cacheTtlSeconds: number;
    readonly thresholdsFile: string;
  };
  readonly providers: {
    readonly openrouterApiKey: string | undefined;
    readonly openaiApiKey: string | undefined;
    readonly anthropicApiKey: string | undefined;
    readonly firecrawlApiKey: string | undefined;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
  }
}

type EnvSource = Record<string, string | undefined>;

/** Rimuove le variabili con valore vuoto: `FOO=` in un file .env equivale a "non impostata". */
export function normalizeEnv(source: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') {
      out[key] = value;
    }
  }
  return out;
}

export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(normalizeEnv(source));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Configurazione non valida:\n- ${issues.join('\n- ')}`, issues);
  }
  return result.data;
}

const csv = (v: string): string[] =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

export function toAppConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    service: { name: env.SERVICE_NAME, version: env.APP_VERSION },
    http: { host: env.HOST, port: env.PORT },
    log: { level: env.LOG_LEVEL },
    db: {
      url: env.DATABASE_URL,
      migrationsUrl: env.MIGRATIONS_DATABASE_URL ?? env.DATABASE_URL,
      appPassword: env.APP_DB_PASSWORD,
      poolMax: env.DATABASE_POOL_MAX,
    },
    ws: {
      allowedOrigins: env.WS_ALLOWED_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter((o) => o !== ''),
    },
    llm: {
      dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
      models: { light: env.MODEL_LIGHT, standard: env.MODEL_STANDARD, heavy: env.MODEL_HEAVY },
    },
    redis: { url: env.REDIS_URL },
    memory: {
      embeddingModel: env.EMBEDDING_MODEL,
      snapshotMaxChars: env.MEMORY_SNAPSHOT_MAX_CHARS,
      retrievalLimit: env.MEMORY_RETRIEVAL_LIMIT,
      consolidationDelaySeconds: env.MEMORY_CONSOLIDATION_DELAY_S,
      retentionDays: env.MEMORY_RETENTION_DAYS,
    },
    tools: {
      categories: csv(env.TOOL_CATEGORIES),
      approvalTtlSeconds: env.TOOL_APPROVAL_TTL_S,
      riskAskThreshold: env.POLICY_RISK_ASK_THRESHOLD,
      webAllowedDomains: csv(env.WEB_ALLOWED_DOMAINS),
      webBlockedDomains: csv(env.WEB_BLOCKED_DOMAINS),
    },
    automations: {
      maxRunBudgetUsd: env.AUTOMATION_MAX_RUN_BUDGET_USD,
      approvalTtlSeconds: env.AUTOMATION_APPROVAL_TTL_S,
      catchUpToleranceSeconds: env.AUTOMATION_CATCHUP_TOLERANCE_S,
      syncEverySeconds: env.AUTOMATION_SYNC_EVERY_S,
      concurrency: env.AUTOMATION_CONCURRENCY,
    },
    push: {
      apns:
        env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY
          ? {
              teamId: env.APNS_TEAM_ID,
              keyId: env.APNS_KEY_ID,
              privateKey: env.APNS_PRIVATE_KEY,
              bundleId: env.APNS_BUNDLE_ID,
            }
          : null,
    },
    router: {
      jevModel: env.JEV_MODEL,
      timeoutMs: env.JEV_TIMEOUT_MS,
      cacheTtlSeconds: env.ROUTER_CACHE_TTL_S,
      thresholdsFile: env.ROUTER_THRESHOLDS_FILE,
    },
    providers: {
      openrouterApiKey: env.OPENROUTER_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      firecrawlApiKey: env.FIRECRAWL_API_KEY,
    },
  };
}

/** Carica e valida la configurazione da `process.env` (o da una sorgente esplicita, utile nei test). */
export function loadConfig(source: EnvSource = process.env): AppConfig {
  return toAppConfig(parseEnv(source));
}

const REDACTED = '[REDACTED]';

function redactUrlCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = REDACTED;
    return u.toString();
  } catch {
    return REDACTED;
  }
}

/** Versione della configurazione sicura da scrivere nei log: nessun segreto in chiaro. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  const present = (v: string | undefined) => (v ? REDACTED : null);
  return {
    env: config.env,
    service: config.service,
    http: config.http,
    log: config.log,
    db: {
      url: redactUrlCredentials(config.db.url),
      migrationsUrl: redactUrlCredentials(config.db.migrationsUrl),
      appPassword: present(config.db.appPassword),
      poolMax: config.db.poolMax,
    },
    ws: config.ws,
    llm: config.llm,
    router: config.router,
    memory: config.memory,
    tools: config.tools,
    automations: config.automations,
    push: {
      apns: config.push.apns
        ? {
            teamId: config.push.apns.teamId,
            keyId: config.push.apns.keyId,
            privateKey: REDACTED,
            bundleId: config.push.apns.bundleId,
          }
        : null,
    },
    redis: { url: redactUrlCredentials(config.redis.url) },
    providers: {
      openrouterApiKey: present(config.providers.openrouterApiKey),
      openaiApiKey: present(config.providers.openaiApiKey),
      anthropicApiKey: present(config.providers.anthropicApiKey),
      firecrawlApiKey: present(config.providers.firecrawlApiKey),
    },
  };
}
