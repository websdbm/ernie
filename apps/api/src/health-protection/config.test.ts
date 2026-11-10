import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { healthCipherFromEnvironment } from './config.js';

describe('health key configuration', () => {
  it('fails closed for absent or malformed dedicated keys; errors never disclose configuration', () => {
    expect(healthCipherFromEnvironment(undefined)).toBeNull();
    for (const raw of [
      'PRIVATE_SECRET',
      JSON.stringify({ activeKeyId: 'x', keys: { x: 'PRIVATE_SECRET' } }),
      JSON.stringify({
        activeKeyId: 'missing',
        keys: { x: Buffer.alloc(32, 7).toString('base64') },
      }),
    ]) {
      expect(() => healthCipherFromEnvironment(raw)).toThrow(
        'I dati protetti non sono disponibili.',
      );
    }
  });
  it('makes independent key copies and supports decryption across process setup', () => {
    const raw = JSON.stringify({
      activeKeyId: 'v1',
      keys: { v1: Buffer.alloc(32, 11).toString('base64') },
    });
    const a = healthCipherFromEnvironment(raw),
      b = healthCipherFromEnvironment(raw);
    if (!a || !b) throw new Error('Missing fixture cipher');
    const context = {
      userId: randomUUID(),
      resourceKind: 'source',
      resourceId: 'test',
      resourceVersion: 1,
    };
    const sealed = a.encrypt(context, Buffer.from('sensitive fixture'));
    a.destroy();
    expect(b.decrypt(context, sealed).toString()).toBe('sensitive fixture');
    b.destroy();
  });
});
