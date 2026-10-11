import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'x-ernie-signature';

/** Firma HMAC-SHA256 del corpo grezzo: `sha256=<hex>`. */
export function signWebhook(secret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = signWebhook(secret, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
