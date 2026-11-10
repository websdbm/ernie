import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../ssh/crypto.js';
import {
  createHealthCipher,
  type HealthKeyring,
  HealthProtectionError,
  type HealthResourceContext,
  MAX_HEALTH_PLAINTEXT_BYTES,
} from './crypto.js';

const context: HealthResourceContext = {
  userId: '12345678-abcd-4123-8123-123456789abc',
  resourceKind: 'report',
  resourceId: 'synthetic-report',
  resourceVersion: 1,
};
const key1 = Buffer.alloc(32, 11);
const key2 = Buffer.alloc(32, 22);
const ring = (activeKeyId = 'k1', keys = new Map([['k1', key1]])): HealthKeyring => ({
  activeKeyId,
  keys,
});
const flip = (encoded: string): string => {
  const bytes = Buffer.from(encoded, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64');
};
function expectUnavailable(operation: () => unknown) {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HealthProtectionError);
  expect(error).toMatchObject({
    name: 'HealthProtectionError',
    code: 'health_data_unavailable',
    message: 'I dati protetti non sono disponibili.',
  });
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toContain(context.userId);
  expect(JSON.stringify(error)).not.toContain(key1.toString('base64'));
}

describe('health record authenticated encryption', () => {
  it('roundtrips Unicode, empty data and binary without replacing bytes or mutating the source', () => {
    const cipher = createHealthCipher(ring());
    const payloads = [
      Buffer.from('Test sintetico: è, e\u0301, 中文, 🧸; \u0000\r\n"\\'),
      Buffer.alloc(0),
      Uint8Array.from({ length: 4096 }, (_, i) => i % 256),
      randomBytes(3_000_000),
    ];
    for (const payload of payloads) {
      const before = Buffer.from(payload);
      const encrypted = cipher.encrypt(context, payload);
      expect(cipher.decrypt(context, JSON.parse(JSON.stringify(encrypted))).equals(before)).toBe(
        true,
      );
      expect(Buffer.from(payload).equals(before)).toBe(true);
      expect(encrypted).toMatchObject({ version: 1, algorithm: 'aes-256-gcm', keyId: 'k1' });
      expect(Buffer.from(encrypted.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(encrypted.tag, 'base64')).toHaveLength(16);
      expect(Object.keys(encrypted).sort()).toEqual([
        'algorithm',
        'ciphertext',
        'iv',
        'keyId',
        'tag',
        'version',
      ]);
    }
    cipher.destroy();
  });

  it('uses a fresh nonce for every encryption of the same record and data', () => {
    const cipher = createHealthCipher(ring());
    const records = Array.from({ length: 64 }, () => cipher.encrypt(context, Buffer.from('same')));
    expect(new Set(records.map((r) => r.iv)).size).toBe(64);
    expect(new Set(records.map((r) => r.ciphertext)).size).toBe(64);
    for (const record of records) expect(cipher.decrypt(context, record).toString()).toBe('same');
    cipher.destroy();
  });

  it('authenticates account, resource kind, exact resource ID and trusted record revision', () => {
    const cipher = createHealthCipher(ring());
    const encrypted = cipher.encrypt(context, Buffer.from('synthetic content'));
    for (const change of [
      { userId: 'aaaaaaaa-abcd-4123-8123-123456789abc' },
      { resourceKind: 'notice' },
      { resourceId: 'another-report' },
      { resourceId: context.resourceId.toUpperCase() },
      { resourceVersion: 2 },
    ])
      expectUnavailable(() => cipher.decrypt({ ...context, ...change }, encrypted));
    // PostgreSQL UUID spelling is case-insensitive; opaque record IDs are not.
    expect(
      cipher.decrypt({ ...context, userId: context.userId.toUpperCase() }, encrypted).toString(),
    ).toBe('synthetic content');
    const unicode = { ...context, resourceId: 'Salute/è 🧸.md' };
    expect(cipher.decrypt(unicode, cipher.encrypt(unicode, Buffer.from('note'))).toString()).toBe(
      'note',
    );
    expectUnavailable(() =>
      cipher.decrypt(
        { ...unicode, resourceId: unicode.resourceId.normalize('NFD') },
        cipher.encrypt(unicode, Buffer.from('note')),
      ),
    );
    cipher.destroy();
  });

  it('does not confuse resource field boundaries or return unauthenticated plaintext', () => {
    const cipher = createHealthCipher(ring());
    const first = { ...context, resourceKind: 'report', resourceId: 'value:same' };
    const second = { ...context, resourceKind: 'report.value', resourceId: 'same' };
    const encrypted = cipher.encrypt(first, Buffer.from('never return this on invalid auth'));
    expectUnavailable(() => cipher.decrypt(second, encrypted));
    for (const field of ['iv', 'tag', 'ciphertext'] as const)
      expectUnavailable(() =>
        cipher.decrypt(first, { ...encrypted, [field]: flip(encrypted[field]) }),
      );
    expectUnavailable(() => cipher.decrypt(first, { ...encrypted, ciphertext: '' }));
    cipher.destroy();
  });

  it('does not reuse the SSH encryption domain even with the same master key', () => {
    const cipher = createHealthCipher(ring());
    const ssh = encryptSecret(key1, context.userId, context.resourceKind, 'synthetic secret');
    expectUnavailable(() =>
      cipher.decrypt(context, { ...ssh, algorithm: 'aes-256-gcm', keyId: 'k1' }),
    );
    cipher.destroy();
  });

  it('rotates the active key, retains previous reads, and rejects retired or substituted keys', () => {
    const oldCipher = createHealthCipher(ring());
    const old = oldCipher.encrypt(context, Buffer.from('original'));
    const rotated = createHealthCipher(
      ring(
        'k2',
        new Map([
          ['k1', key1],
          ['k2', key2],
        ]),
      ),
    );
    expect(rotated.decrypt(context, old).toString()).toBe('original');
    const current = rotated.encrypt(context, rotated.decrypt(context, old));
    expect(current.keyId).toBe('k2');
    expect(rotated.decrypt(context, current).toString()).toBe('original');
    expectUnavailable(() => oldCipher.decrypt(context, current));
    const retired = createHealthCipher(ring('k2', new Map([['k2', key2]])));
    expectUnavailable(() => retired.decrypt(context, old));
    expect(retired.decrypt(context, current).toString()).toBe('original');
    expectUnavailable(() => rotated.decrypt(context, { ...old, keyId: 'k2' }));
    // Key ID is part of derivation and authentication, even when configuration repeats raw material.
    const repeated = createHealthCipher(
      ring(
        'alias',
        new Map([
          ['k1', key1],
          ['alias', key1],
        ]),
      ),
    );
    expectUnavailable(() => repeated.decrypt(context, { ...old, keyId: 'alias' }));
    const wrong = createHealthCipher(ring('k1', new Map([['k1', key2]])));
    expectUnavailable(() => wrong.decrypt(context, old));
    for (const cipher of [oldCipher, rotated, retired, repeated, wrong]) cipher.destroy();
  });

  it('rejects unknown format/algorithm versions and malformed envelopes uniformly', () => {
    const cipher = createHealthCipher(ring());
    const encrypted = cipher.encrypt(context, Buffer.from('sample'));
    const missingTag: Record<string, unknown> = { ...encrypted };
    delete missingTag.tag;
    for (const value of [
      null,
      undefined,
      'plaintext is not a legacy fallback',
      [],
      {},
      missingTag,
      { ...encrypted, version: 2 },
      { ...encrypted, version: '1' },
      { ...encrypted, algorithm: 'aes-256-cbc' },
      { ...encrypted, keyId: 'missing' },
      { ...encrypted, keyId: 'x'.repeat(65) },
      { ...encrypted, plaintext: 'unexpected' },
      { ...encrypted, iv: Buffer.alloc(11).toString('base64') },
      { ...encrypted, tag: Buffer.alloc(4).toString('base64') },
      { ...encrypted, iv: `${encrypted.iv}\n` },
      { ...encrypted, tag: encrypted.tag.slice(0, -2) },
      { ...encrypted, ciphertext: `${encrypted.ciphertext}#` },
      { ...encrypted, ciphertext: 3 },
    ])
      expectUnavailable(() => cipher.decrypt(context, value));
    cipher.destroy();
  });

  it('validates context and enforces byte limits before encryption/decryption', () => {
    const cipher = createHealthCipher(ring());
    const encrypted = cipher.encrypt(context, Buffer.from('sample'));
    for (const change of [
      { userId: '' },
      { userId: 'not-an-account' },
      { resourceKind: '' },
      { resourceKind: 'report:another' },
      { resourceKind: 'x'.repeat(65) },
      { resourceId: '' },
      { resourceId: 'x'.repeat(513) },
      { resourceVersion: 0 },
      { resourceVersion: -1 },
      { resourceVersion: 1.5 },
      { resourceVersion: Number.MAX_SAFE_INTEGER + 1 },
      { resourceVersion: Number.NaN },
    ]) {
      expectUnavailable(() => cipher.encrypt({ ...context, ...change }, Buffer.from('sample')));
      expectUnavailable(() => cipher.decrypt({ ...context, ...change }, encrypted));
    }
    expectUnavailable(() => cipher.encrypt(context, Buffer.alloc(MAX_HEALTH_PLAINTEXT_BYTES + 1)));
    // This length fits the rounded base64 cap but decodes to one excess byte.
    expectUnavailable(() =>
      cipher.decrypt(context, {
        ...encrypted,
        ciphertext: Buffer.alloc(MAX_HEALTH_PLAINTEXT_BYTES + 1).toString('base64'),
      }),
    );
    expectUnavailable(() =>
      cipher.decrypt(context, {
        ...encrypted,
        ciphertext: 'A'.repeat(Math.ceil(MAX_HEALTH_PLAINTEXT_BYTES / 3) * 4 + 4),
      }),
    );
    cipher.destroy();
  });

  it('fails closed on invalid or missing key configuration, without an implicit default', () => {
    for (const invalid of [
      undefined,
      {},
      { activeKeyId: 'k1', keys: {} },
      ring('k1', new Map()),
      ring('missing'),
      ring('invalid key'),
      ring('k1', new Map([['k1', Buffer.alloc(31)]])),
      ring('k1', new Map([['k1', Buffer.alloc(33)]])),
      ring(
        'k1',
        new Map([
          ['k1', key1],
          ['', key2],
        ]),
      ),
    ])
      expectUnavailable(() => createHealthCipher(invalid as HealthKeyring));
  });

  it('copies configuration, never exports keys, and refuses all operations after disposal', () => {
    const sourceKey = Buffer.from(key1);
    const source = new Map([['k1', sourceKey]]);
    const cipher = createHealthCipher(ring('k1', source));
    const encrypted = cipher.encrypt(context, Buffer.from('sample'));
    sourceKey.fill(0);
    source.clear();
    expect(cipher.decrypt(context, encrypted).toString()).toBe('sample');
    expect(cipher.encrypt(context, Buffer.from('sample')).keyId).toBe('k1');
    expect(Object.keys(cipher).sort()).toEqual(['decrypt', 'destroy', 'encrypt']);
    expect(JSON.stringify(cipher)).toBe('{}');
    cipher.destroy();
    cipher.destroy();
    expectUnavailable(() => cipher.decrypt(context, encrypted));
    expectUnavailable(() => cipher.encrypt(context, Buffer.from('sample')));
  });
});
