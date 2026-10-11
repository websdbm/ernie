import type { Logger } from '@ernie/observability';

/**
 * Email transazionali via Brevo (richiesta dell'utente: promemoria anche per email). Solo testo semplice,
 * mittente verificato su Brevo; nessun contenuto oltre il titolo e il corpo della notifica.
 */
export interface Mailer {
  send(input: { to: string; subject: string; text: string }): Promise<{ messageId: string | null }>;
}

export interface BrevoOptions {
  readonly apiKey: string;
  readonly senderEmail: string;
  readonly senderName?: string;
  readonly fetch?: typeof fetch;
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
}

export function createBrevoMailer(opts: BrevoOptions): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send({ to, subject, text }) {
      const res = await doFetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': opts.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: opts.senderEmail, name: opts.senderName ?? 'Ernie' },
          to: [{ email: to }],
          subject: subject.slice(0, 200),
          textContent: text.slice(0, 10_000),
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`Brevo ${res.status}: ${body}`);
      }
      const json = (await res.json().catch(() => null)) as { messageId?: string } | null;
      opts.logger?.info({ to, subject }, 'email inviata');
      return { messageId: json?.messageId ?? null };
    },
  };
}

/** Indirizzo e consenso dell'utente alle notifiche via email (impostazioni: `email`, `emailNotifications`). */
export function emailRecipient(settings: Readonly<Record<string, unknown>>): string | null {
  const email = typeof settings.email === 'string' ? settings.email.trim() : '';
  if (!email || settings.emailNotifications !== true) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
