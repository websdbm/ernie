import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { createLogger, redactUrl } from './logger.js';

function collector() {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(msg: string) {
        lines.push(msg);
      },
    },
  };
}

describe('createLogger', () => {
  it('scrive JSON strutturato con nome e livello', () => {
    const { lines, stream } = collector();
    const log = createLogger({ level: 'info', name: 'test', destination: stream });
    log.info({ foo: 'bar' }, 'ciao');
    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.name).toBe('test');
    expect(parsed.msg).toBe('ciao');
    expect(parsed.foo).toBe('bar');
    expect(parsed.level).toBe(30);
    expect(typeof parsed.time).toBe('string');
  });

  it('redige le credenziali annidate', () => {
    const { lines, stream } = collector();
    const log = createLogger({ level: 'info', name: 'test', destination: stream });
    log.info(
      {
        providers: { openrouterApiKey: 'sk-or-secret' },
        db: { password: 'pw' },
        req: { headers: { authorization: 'Bearer abc' } },
      },
      'config',
    );
    const line = lines[0] ?? '';
    expect(line).not.toContain('sk-or-secret');
    expect(line).not.toContain('"pw"');
    expect(line).not.toContain('Bearer abc');
    expect(line).toContain('[REDACTED]');
  });

  it('redige i parametri sensibili nell’URL della richiesta (chiave del webhook in query string)', () => {
    expect(redactUrl('/v1/brain/inbound/email?key=abc123&x=1')).toBe(
      '/v1/brain/inbound/email?key=[REDACTED]&x=1',
    );
    expect(redactUrl('/a?x=1&api_key=k&token=t&secret=s&Signature=z')).toBe(
      '/a?x=1&api_key=[REDACTED]&token=[REDACTED]&secret=[REDACTED]&Signature=[REDACTED]',
    );
    expect(redactUrl('/a?keyword=ok&monkey=1')).toBe('/a?keyword=ok&monkey=1');
    expect(redactUrl('/senza/query')).toBe('/senza/query');

    const { lines, stream } = collector();
    const log = createLogger({ level: 'info', name: 'test', destination: stream });
    log.info(
      {
        req: {
          method: 'POST',
          url: '/v1/brain/inbound/email?key=supersegreta',
          host: 'ernie.example',
          ip: '10.0.0.1',
          headers: { 'accept-version': '1' },
          socket: { remotePort: 4321 },
        },
      },
      'incoming request',
    );
    const line = lines[0] ?? '';
    expect(line).not.toContain('supersegreta');
    const parsed = JSON.parse(line);
    expect(parsed.req).toEqual({
      method: 'POST',
      url: '/v1/brain/inbound/email?key=[REDACTED]',
      version: '1',
      host: 'ernie.example',
      remoteAddress: '10.0.0.1',
      remotePort: 4321,
    });
  });

  it('rispetta il livello minimo', () => {
    const { lines, stream } = collector();
    const log = createLogger({ level: 'warn', name: 'test', destination: stream });
    log.info('nascosto');
    log.warn('visibile');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('visibile');
  });
});

describe('newId', () => {
  it('genera UUID v4 distinti', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
