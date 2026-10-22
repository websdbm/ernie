import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SshError } from './types.js';

export interface EncryptedSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}
export function parseMasterKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value)
    throw new SshError(
      'invalid_master_key',
      'La chiave di cifratura SSH deve essere base64 e contenere 32 byte.',
      503,
    );
  return bytes;
}
const aad = (userId: string, kind: string) =>
  Buffer.from(JSON.stringify(['ernie-ssh', 1, userId.toLowerCase(), kind]));
export function encryptSecret(
  key: Buffer,
  userId: string,
  kind: string,
  plaintext: string,
): EncryptedSecret {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(userId, kind));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}
export function decryptSecret(
  key: Buffer,
  userId: string,
  kind: string,
  secret: EncryptedSecret,
): string {
  try {
    if (secret.version !== 1) throw new Error('version');
    const iv = Buffer.from(secret.iv, 'base64'),
      tag = Buffer.from(secret.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('envelope');
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(userId, kind));
    cipher.setAuthTag(tag);
    return Buffer.concat([
      cipher.update(Buffer.from(secret.ciphertext, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SshError(
      'secret_unavailable',
      'La credenziale non può essere decifrata. Ricollegala senza esporre il segreto.',
      503,
    );
  }
}
