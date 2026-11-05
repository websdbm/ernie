import { ChatArchiveError } from './types.js';

/** Stored targets are metadata only; never fetched, resolved or used to send messages by the server. */
export function normalizeWhatsAppPhone(input: string | null): string | null {
  if (input === null || input.trim() === '') return null;
  const value = input.trim().replace(/[\s()+.-]/gu, '');
  if (!/^[1-9]\d{6,14}$/u.test(value))
    throw new ChatArchiveError(
      400,
      'invalid_whatsapp_phone',
      'Inserisci il numero completo con prefisso internazionale.',
    );
  return value;
}
export function normalizeWhatsAppUrl(input: string | null): string | null {
  if (input === null || input.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ChatArchiveError(400, 'invalid_whatsapp_url', 'Collegamento WhatsApp non valido.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new ChatArchiveError(
      400,
      'invalid_whatsapp_url',
      'Usa un collegamento WhatsApp HTTPS senza parametri.',
    );
  const accepted =
    (host === 'wa.me' && /^\/[1-9]\d{6,14}\/?$/u.test(url.pathname)) ||
    (host === 'chat.whatsapp.com' && /^\/[A-Za-z0-9_-]{10,128}\/?$/u.test(url.pathname)) ||
    ((host === 'www.whatsapp.com' || host === 'whatsapp.com') &&
      /^\/channel\/[A-Za-z0-9_-]{10,128}\/?$/u.test(url.pathname));
  if (!accepted)
    throw new ChatArchiveError(
      400,
      'invalid_whatsapp_url',
      'Usa un link wa.me, di invito al gruppo o del canale WhatsApp.',
    );
  return `https://${host}${url.pathname.replace(/\/$/u, '')}`;
}
