import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from './webhook.js';

describe('firma dei webhook (HMAC-SHA256 sul corpo grezzo)', () => {
  const secret = 'segreto-di-prova';
  const body = '{"ordine":42,"stato":"consegnato"}';
  it('firma e verifica coincidono', () => {
    const sig = signWebhook(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });
  it('corpo alterato, segreto diverso, header assente o malformato → non valida', () => {
    const sig = signWebhook(secret, body);
    expect(verifyWebhookSignature(secret, `${body} `, sig)).toBe(false);
    expect(verifyWebhookSignature('altro', body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=abc')).toBe(false);
  });
});
