import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, normalizeEnv, parseEnv, redactConfig } from './env.js';

const minimal = {
  DATABASE_URL: 'postgres://ernie:secret@localhost:5433/ernie',
  REDIS_URL: 'redis://localhost:6380',
};

describe('parseEnv', () => {
  it('applica i valori di default', () => {
    const env = parseEnv(minimal);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('converte PORT da stringa a numero', () => {
    expect(parseEnv({ ...minimal, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rifiuta una PORT non valida con un messaggio leggibile', () => {
    expect(() => parseEnv({ ...minimal, PORT: '99999' })).toThrowError(ConfigError);
    try {
      parseEnv({ ...minimal, PORT: 'abc' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join('\n')).toContain('PORT');
    }
  });

  it('richiede DATABASE_URL e REDIS_URL', () => {
    expect(() => parseEnv({})).toThrowError(/DATABASE_URL/);
    expect(() => parseEnv({})).toThrowError(/REDIS_URL/);
  });

  it('rifiuta schemi URL errati', () => {
    expect(() => parseEnv({ ...minimal, DATABASE_URL: 'mysql://x/y' })).toThrowError(/postgres/);
    expect(() => parseEnv({ ...minimal, REDIS_URL: 'http://x' })).toThrowError(/redis/);
  });

  it('tratta le variabili vuote come assenti', () => {
    const env = parseEnv({ ...minimal, OPENROUTER_API_KEY: '', OPENAI_API_KEY: '  ' });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(normalizeEnv({ A: '', B: 'x', C: undefined })).toEqual({ B: 'x' });
  });
});

describe('loadConfig / redactConfig', () => {
  it('produce una configurazione strutturata', () => {
    const config = loadConfig({
      ...minimal,
      OPENROUTER_API_KEY: 'sk-or-123',
      APP_VERSION: '1.2.3',
    });
    expect(config.service.version).toBe('1.2.3');
    expect(config.db.url).toBe(minimal.DATABASE_URL);
    expect(config.providers.openrouterApiKey).toBe('sk-or-123');
    expect(config.providers.openaiApiKey).toBeUndefined();
  });

  it('non espone segreti nella versione redatta', () => {
    const config = loadConfig({ ...minimal, OPENROUTER_API_KEY: 'sk-or-123' });
    const redacted = JSON.stringify(redactConfig(config));
    expect(redacted).not.toContain('sk-or-123');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain('localhost:5433');
  });
});
