import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const USER_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const SALT = Buffer.from('ernie-health:account-key:hkdf-sha256:v1', 'utf8');
const ENVELOPE_KEYS = 'algorithm,ciphertext,iv,keyId,tag,version';

/** Bounded in-memory records, including the current 3 MB media upload limit. */
export const MAX_HEALTH_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CIPHERTEXT_BASE64 = Math.ceil(MAX_HEALTH_PLAINTEXT_BYTES / 3) * 4;

export interface HealthResourceContext {
  /** Trusted authenticated account, not taken from the encrypted envelope. */
  readonly userId: string;
  readonly resourceKind: string;
  /** Stable record ID or path; compared exactly, without case/Unicode normalization. */
  readonly resourceId: string;
  /** Trusted record revision. Bind it to persistence to prevent replay of older revisions. */
  readonly resourceVersion: number;
}

export interface HealthEncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly keyId: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface HealthKeyring {
  readonly activeKeyId: string;
  /** Raw, random 32-byte keys supplied by configuration; never passwords. */
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export interface HealthCipher {
  encrypt(context: HealthResourceContext, plaintext: Uint8Array): HealthEncryptedEnvelope;
  decrypt(context: HealthResourceContext, envelope: unknown): Buffer;
  /** Best-effort disposal of this instance's key copies; subsequent operations fail closed. */
  destroy(): void;
}

/** No caller-controlled values, key material, OpenSSL details or nested cause in errors. */
export class HealthProtectionError extends Error {
  override readonly name = 'HealthProtectionError';
  readonly code = 'health_data_unavailable';

  constructor() {
    super('I dati protetti non sono disponibili.');
  }
}

function resourceContext(context: HealthResourceContext): HealthResourceContext {
  if (
    !context ||
    typeof context.userId !== 'string' ||
    !USER_ID.test(context.userId) ||
    typeof context.resourceKind !== 'string' ||
    !KIND.test(context.resourceKind) ||
    typeof context.resourceId !== 'string' ||
    context.resourceId.length === 0 ||
    context.resourceId.length > 512 ||
    !Number.isSafeInteger(context.resourceVersion) ||
    context.resourceVersion < 1
  )
    throw new HealthProtectionError();
  return { ...context, userId: context.userId.toLowerCase() };
}

function decodeBase64(value: unknown, maxChars: number, bytes?: number): Buffer {
  if (typeof value !== 'string' || value.length > maxChars) throw new HealthProtectionError();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (bytes !== undefined && decoded.length !== bytes))
    throw new HealthProtectionError();
  return decoded;
}

function envelope(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== ENVELOPE_KEYS
  )
    throw new HealthProtectionError();
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== VERSION ||
    raw.algorithm !== ALGORITHM ||
    typeof raw.keyId !== 'string' ||
    !KEY_ID.test(raw.keyId)
  )
    throw new HealthProtectionError();
  const ciphertext = decodeBase64(raw.ciphertext, MAX_CIPHERTEXT_BASE64);
  if (ciphertext.length > MAX_HEALTH_PLAINTEXT_BYTES) throw new HealthProtectionError();
  return {
    keyId: raw.keyId,
    iv: decodeBase64(raw.iv, 16, IV_BYTES),
    tag: decodeBase64(raw.tag, 24, TAG_BYTES),
    ciphertext,
  };
}

function authenticatedData(context: HealthResourceContext, keyId: string): Buffer {
  // JSON arrays preserve field boundaries, including punctuation/Unicode in resource IDs.
  return Buffer.from(
    JSON.stringify([
      'ernie-health:record',
      VERSION,
      ALGORITHM,
      keyId,
      context.userId,
      context.resourceKind,
      context.resourceId,
      context.resourceVersion,
    ]),
    'utf8',
  );
}

/**
 * Isolated cryptographic primitive, not an authorization or consent check. No storage or migration.
 * Uses Node AES-GCM authentication and HKDF: https://nodejs.org/docs/latest-v24.x/api/crypto.html
 * Key IDs and format versions are authenticated; old keys remain read-only after active-key rotation.
 * The caller must provide trusted context, retain previous keys until migration completes, and enforce
 * consent/revocation separately. Possession of the master key permits decryption: this is not E2EE.
 */
export function createHealthCipher(keyring: HealthKeyring): HealthCipher {
  const keys = new Map<string, Buffer>();
  let activeKeyId: string;
  try {
    if (
      !keyring ||
      typeof keyring.activeKeyId !== 'string' ||
      !KEY_ID.test(keyring.activeKeyId) ||
      !(keyring.keys instanceof Map) ||
      keyring.keys.size === 0 ||
      keyring.keys.size > 32
    )
      throw new HealthProtectionError();
    activeKeyId = keyring.activeKeyId;
    for (const [id, key] of keyring.keys) {
      if (typeof id !== 'string' || !KEY_ID.test(id) || !(key instanceof Uint8Array))
        throw new HealthProtectionError();
      if (key.byteLength !== KEY_BYTES) throw new HealthProtectionError();
      keys.set(id, Buffer.from(key));
    }
    if (!keys.has(activeKeyId)) throw new HealthProtectionError();
  } catch {
    for (const key of keys.values()) key.fill(0);
    keys.clear();
    throw new HealthProtectionError();
  }

  const derive = (context: HealthResourceContext, keyId: string): Buffer => {
    const master = keys.get(keyId);
    if (!master) throw new HealthProtectionError();
    return Buffer.from(
      hkdfSync(
        'sha256',
        master,
        SALT,
        Buffer.from(JSON.stringify(['ernie-health:account', VERSION, keyId, context.userId])),
        KEY_BYTES,
      ),
    );
  };

  return Object.freeze({
    encrypt(context: HealthResourceContext, plaintext: Uint8Array): HealthEncryptedEnvelope {
      let key: Buffer | undefined;
      try {
        const owner = resourceContext(context);
        if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_HEALTH_PLAINTEXT_BYTES)
          throw new HealthProtectionError();
        key = derive(owner, activeKeyId);
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(authenticatedData(owner, activeKeyId));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Object.freeze({
          version: VERSION,
          algorithm: ALGORITHM,
          keyId: activeKeyId,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        });
      } catch {
        throw new HealthProtectionError();
      } finally {
        key?.fill(0);
      }
    },
    decrypt(context: HealthResourceContext, value: unknown): Buffer {
      let key: Buffer | undefined;
      let unauthenticated: Buffer | undefined;
      let final: Buffer | undefined;
      try {
        const owner = resourceContext(context);
        const encrypted = envelope(value);
        key = derive(owner, encrypted.keyId);
        const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(authenticatedData(owner, encrypted.keyId));
        decipher.setAuthTag(encrypted.tag);
        unauthenticated = decipher.update(encrypted.ciphertext);
        final = decipher.final();
        // No plaintext escapes before successful tag verification in final().
        return Buffer.concat([unauthenticated, final]);
      } catch {
        throw new HealthProtectionError();
      } finally {
        key?.fill(0);
        unauthenticated?.fill(0);
        final?.fill(0);
      }
    },
    destroy() {
      for (const key of keys.values()) key.fill(0);
      keys.clear();
    },
  });
}
