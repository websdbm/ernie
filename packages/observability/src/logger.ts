import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino';

export type { Logger };

/**
 * Percorsi redatti in ogni riga di log. Copre header sensibili e qualunque campo
 * che assomigli a una credenziale, a qualsiasi profondità ragionevole.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'api_key',
  '*.api_key',
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'providers.*',
];

/** Parametri di query che portano credenziali: il loro valore non deve finire nei log. */
const SENSITIVE_QUERY_PARAM =
  /^(key|api[_-]?key|token|access[_-]?token|secret|password|pass|signature|sig|auth)$/i;

/**
 * URL con i valori dei parametri sensibili sostituiti da `[REDACTED]` (es. la chiave del webhook
 * di Brevo, che può viaggiare solo nella query string). Il percorso e gli altri parametri restano.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const query = url
    .slice(q + 1)
    .replace(/(^|[&;])([^=&;#]+)=([^&;#]*)/g, (whole, sep: string, name: string) =>
      SENSITIVE_QUERY_PARAM.test(safeDecode(name)) ? `${sep}${name}=[REDACTED]` : whole,
    );
  return `${url.slice(0, q + 1)}${query}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface RequestLike {
  readonly method?: unknown;
  readonly url?: unknown;
  readonly host?: unknown;
  readonly ip?: unknown;
  readonly headers?: { readonly [k: string]: unknown } | undefined;
  readonly socket?: { readonly remotePort?: unknown } | undefined;
}

/**
 * Serializzatore di `req` (stessi campi di quello di Fastify, che viene sovrascritto da questo),
 * con l'URL redatto. Oggetti che non sembrano richieste HTTP passano invariati, così la redazione
 * per percorso (`req.headers.authorization`…) continua a valere.
 */
function serializeRequest(req: unknown): unknown {
  if (!req || typeof req !== 'object') return req;
  const r = req as RequestLike;
  if (typeof r.method !== 'string' || typeof r.url !== 'string') return req;
  return {
    method: r.method,
    url: redactUrl(r.url),
    version: r.headers?.['accept-version'],
    host: r.host,
    remoteAddress: r.ip,
    remotePort: r.socket?.remotePort,
  };
}

export interface CreateLoggerOptions {
  readonly level: string;
  readonly name: string;
  /** Output leggibile (pino-pretty), solo per sviluppo locale. */
  readonly pretty?: boolean;
  /** Campi aggiunti a ogni riga (es. versione, ambiente). */
  readonly base?: Record<string, unknown>;
  /** Destinazione esplicita (usata nei test). */
  readonly destination?: DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: opts.level,
    name: opts.name,
    base: opts.base ?? {},
    redact: { paths: [...DEFAULT_REDACT_PATHS], censor: '[REDACTED]' },
    serializers: { req: serializeRequest, err: pino.stdSerializers.err },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.destination) {
    return pino(options, opts.destination);
  }

  if (opts.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options);
}
