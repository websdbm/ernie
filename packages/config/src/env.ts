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
    redis: { url: redactUrlCredentials(config.redis.url) },
    providers: {
      openrouterApiKey: present(config.providers.openrouterApiKey),
      openaiApiKey: present(config.providers.openaiApiKey),
      anthropicApiKey: present(config.providers.anthropicApiKey),
      firecrawlApiKey: present(config.providers.firecrawlApiKey),
    },
  };
}
