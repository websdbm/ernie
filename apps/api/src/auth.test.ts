import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX, extractBearer, generateApiKey, hashApiKey } from './auth.js';

describe('api keys', () => {
  it('genera chiavi con prefisso e hash stabile', () => {
    const { key, hash } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(40);
    expect(hash.equals(hashApiKey(key))).toBe(true);
    expect(generateApiKey().key).not.toBe(key);
  });

  it('estrae il bearer in modo tollerante', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer   abc ')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
  });
});
