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
