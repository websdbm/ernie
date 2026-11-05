import { describe, expect, it } from 'vitest';
import { normalizeWhatsAppPhone, normalizeWhatsAppUrl } from './whatsapp.js';

describe('safe WhatsApp target metadata', () => {
  it('accepts known targets without sending or fetching anything', () => {
    expect(normalizeWhatsAppPhone('+39 123 456 7890')).toBe('391234567890');
    expect(normalizeWhatsAppPhone(null)).toBeNull();
    for (const url of [
      'https://wa.me/391234567890',
      'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv',
      'https://www.whatsapp.com/channel/0029AbCdEfGhIj',
    ])
      expect(normalizeWhatsAppUrl(url)).toBe(url);
  });
  it('rejects external/schemed targets, credentials, query injection and malformed phone numbers', () => {
    for (const url of [
      'http://wa.me/391234567890',
      'https://wa.me.evil.test/391234567890',
      'https://user:password@wa.me/391234567890',
      'https://wa.me/391234567890?text=send',
      'javascript:alert(1)',
      'https://127.0.0.1/test',
      'https://chat.whatsapp.com/a',
    ])
      expect(() => normalizeWhatsAppUrl(url)).toThrow();
    for (const phone of ['123', '00012345678', '+39123?text=x', '+391234567890123456'])
      expect(() => normalizeWhatsAppPhone(phone)).toThrow();
  });
});
