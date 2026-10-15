/**
 * Inoltro email al second brain (fase B3). Brevo riceve la posta del sottodominio dedicato (record MX) e chiama
 * il nostro webhook con il messaggio già estratto in markdown. L'indirizzo è personale: `<token>@<dominio>`; il
 * mittente deve essere l'email della scheda dell'utente, altrimenti il messaggio si ignora.
 */

/** Giorno «YYYY-MM-DD» a Roma (i container sono in UTC: tra mezzanotte e le 2 la data UTC è ancora ieri). */
const romeDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);

export interface InboundEmail {
  readonly messageId: string;
  /** Token dell'indirizzo di destinazione (parte prima della chiocciola), minuscolo. */
  readonly token: string;
  readonly from: string;
  readonly fromName: string;
  readonly subject: string;
  readonly text: string;
  /** YYYY-MM-DD, se la data è leggibile. */
  readonly sentOn: string | null;
  readonly attachments: string[];
}

const TOKEN_RE = /^[a-z0-9]{8,32}$/;

/** `<token>@dominio` → token; null se l'indirizzo non è del dominio o non ha la forma attesa. */
export function inboundToken(address: string, domain: string): string | null {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(address.trim().toLowerCase());
  if (!m || m[2] !== domain.toLowerCase()) return null;
  const local = (m[1] ?? '').replace(/\+.*$/, '');
  return TOKEN_RE.test(local) ? local : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Testo senza tag HTML, per le email che arrivano solo in HTML. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** «Fwd: I: R: Oggetto» → «Oggetto»; vuoto se non resta niente. */
export function cleanSubject(subject: string): string {
  return subject
    .replace(/^(\s*(fwd?|fw|i|r|re|tr|wg|aw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Messaggi nel corpo del webhook di Brevo (`items`), con il token del destinatario del nostro dominio. */
export function parseInboundPayload(body: unknown, domain: string): InboundEmail[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: InboundEmail[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const addresses = [
      ...(Array.isArray(it.To) ? it.To : []),
      ...(Array.isArray(it.Recipients) ? it.Recipients : []),
    ]
      .map((r) => (typeof r === 'string' ? r : str((r as { Address?: unknown })?.Address)))
      .filter(Boolean);
    const token = addresses
      .map((a) => inboundToken(a, domain))
      .find((t): t is string => t !== null);
    if (!token) continue;
    const from = it.From as { Address?: unknown; Name?: unknown } | undefined;
    const text =
      str(it.ExtractedMarkdownMessage).trim() ||
      str(it.RawTextBody).trim() ||
      stripHtml(str(it.RawHtmlBody));
    const sentRaw = str(it.SentAtDate);
    const sent = sentRaw ? new Date(sentRaw) : null;
    const attachments = (Array.isArray(it.Attachments) ? it.Attachments : [])
      .map((a) => str((a as { Name?: unknown })?.Name))
      .filter(Boolean);
    out.push({
      messageId: str(it.MessageId) || `${token}:${sentRaw}:${str(it.Subject)}`,
      token,
      from: str(from?.Address).trim().toLowerCase(),
      fromName: str(from?.Name).trim(),
      subject: str(it.Subject),
      text: text.slice(0, 60_000),
      sentOn: sent && !Number.isNaN(sent.getTime()) ? romeDate(sent) : null,
      attachments,
    });
  }
  return out;
}

/** Nota dal messaggio: titolo dall'oggetto, testo in markdown, allegati elencati (non scaricati). */
export function emailToNote(m: InboundEmail, now = new Date()): { title: string; body: string } {
  const day = m.sentOn ?? romeDate(now);
  const title = cleanSubject(m.subject) || `Email del ${day}`;
  const parts = [m.text || '_(messaggio vuoto)_'];
  if (m.attachments.length)
    parts.push(`Allegati (non scaricati): ${m.attachments.map((a) => `«${a}»`).join(', ')}`);
  parts.push(`_Arrivata via email il ${day}${m.fromName ? ` da ${m.fromName}` : ''}._`);
  return { title, body: parts.join('\n\n') };
}

/** Token dell'indirizzo personale: 12 caratteri senza ambiguità (si detta e si copia). */
export function newInboxToken(random: () => number = Math.random): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return s;
}

/** Indirizzi (minuscoli, senza spazi, senza doppioni) da un valore qualsiasi delle impostazioni. */
export function normalizeEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const e = v.trim().toLowerCase();
    if (e?.includes('@') && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Mittenti da cui si accettano gli inoltri: l'email della scheda più gli «altri indirizzi» (es. quello di lavoro)
 * che l'utente ha aggiunto dall'app. Tutto minuscolo, così il confronto con `From` è insensibile alle maiuscole.
 */
export function authorizedSenders(settings: {
  readonly email?: unknown;
  readonly extraEmails?: unknown;
}): Set<string> {
  const out = new Set<string>();
  if (typeof settings.email === 'string' && settings.email.trim())
    out.add(settings.email.trim().toLowerCase());
  for (const e of normalizeEmails(settings.extraEmails)) out.add(e);
  return out;
}
