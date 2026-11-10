import { createHealthCipher, type HealthCipher, HealthProtectionError } from './crypto.js';

/** Dedicated keyring, never reused from SSH or returned by capabilities. Absence disables the vault. */
export function healthCipherFromEnvironment(raw: string | undefined): HealthCipher | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { activeKeyId?: unknown; keys?: unknown };
    if (
      typeof value.activeKeyId !== 'string' ||
      !value.keys ||
      typeof value.keys !== 'object' ||
      Array.isArray(value.keys)
    )
      throw new HealthProtectionError();
    const keys = new Map<string, Buffer>();
    try {
      for (const [id, encoded] of Object.entries(value.keys)) {
        if (typeof encoded !== 'string') throw new HealthProtectionError();
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== 32 || bytes.toString('base64') !== encoded)
          throw new HealthProtectionError();
        keys.set(id, bytes);
      }
      return createHealthCipher({ activeKeyId: value.activeKeyId, keys });
    } finally {
      for (const key of keys.values()) key.fill(0);
    }
  } catch {
    throw new HealthProtectionError();
  }
}
