import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Check } from './schema.js';

/**
 * Controlli economici prima del modello (ricerca 11, C5; idee da Hermes Agent e OpenClaw). Insieme chiuso:
 * pagina cambiata (hash del testo) e nuove voci di un feed RSS/Atom. Se non cambia nulla la run finisce senza
 * modello; se cambia, il diff entra nel prompt come dato NON fidato (la run è contaminata). Un errore della
 * fonte conta come errore, mai come cambiamento.
 * Il worker scarica indirizzi scelti dall'utente: niente rete interna (localhost, reti private, metadati cloud).
 */
export interface CheckResult {
  readonly changed: boolean;
  readonly state: Record<string, unknown>;
  /** Cosa è cambiato, per il prompt (≤ 3.000 caratteri). */
  readonly diff?: string;
}

export interface CheckDeps {
  readonly fetch?: typeof fetch;
  readonly resolve?: (host: string) => Promise<string[]>;
  readonly timeoutMs?: number;
}

export class CheckSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckSourceError';
  }
}

/** Indirizzi che il worker non deve mai raggiungere (SSRF). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT, anche Tailscale
      (a === 169 && b === 254) || // link-local, metadati cloud
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80')
  );
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true })).map((a) => a.address);

async function safeGet(url: string, deps: CheckDeps): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CheckSourceError('indirizzo non valido');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new CheckSourceError('solo http e https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host))
    throw new CheckSourceError('indirizzo interno non ammesso');
  const addrs = isIP(host) ? [host] : await (deps.resolve ?? defaultResolve)(host).catch(() => []);
  if (!addrs.length) throw new CheckSourceError('nome non risolto');
  if (addrs.some(isPrivateAddress)) throw new CheckSourceError('indirizzo interno non ammesso');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? 10_000);
  try {
    const res = await (deps.fetch ?? fetch)(u, {
      signal: ac.signal,
      redirect: 'manual', // un redirect verso la rete interna non deve passare
      headers: {
        'user-agent': 'Ernie-sentinella/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
      },
    });
    if (res.status >= 300 && res.status < 400)
      throw new CheckSourceError(`redirect non seguito (${res.status})`);
    if (!res.ok) throw new CheckSourceError(`la fonte ha risposto ${res.status}`);
    const text = await res.text();
    return text.slice(0, 2_000_000);
  } catch (err) {
    if (err instanceof CheckSourceError) throw err;
    throw new CheckSourceError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Testo leggibile di una pagina HTML: niente script, stili, menu; spazi compattati; righe significative. */
export function pageText(html: string): string[] {
  const body = html
    .replace(/<(script|style|noscript|nav|footer|header|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  return body
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 2)
    .slice(0, 4_000);
}

export interface FeedItem {
  readonly id: string;
  readonly title: string;
  readonly link: string;
}

/** Voci di un feed RSS o Atom (estrazione semplice, tollerante). */
export function feedItems(xml: string): FeedItem[] {
  const pick = (block: string, tag: string) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return (m?.[1] ?? '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
  };
  const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return items.slice(0, 100).map((b) => {
    const href = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '';
    const link = pick(b, 'link') || href;
    const id = pick(b, 'guid') || pick(b, 'id') || link || pick(b, 'title');
    return { id, title: pick(b, 'title').slice(0, 200), link: link.slice(0, 300) };
  });
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function evaluateCheck(
  check: Check,
  state: Readonly<Record<string, unknown>> | null,
  deps: CheckDeps = {},
): Promise<CheckResult> {
  const raw = await safeGet(check.url, deps);
  if (check.type === 'page_changed') {
    const lines = pageText(raw);
    const hash = sha(lines.join('\n'));
    const kept = lines.join('\n').slice(0, 12_000);
    const prev = typeof state?.hash === 'string' ? state.hash : null;
    const prevText = typeof state?.text === 'string' ? state.text : '';
    const next = { hash, text: kept, checkedAt: new Date().toISOString() };
    if (!prev) return { changed: false, state: next }; // primo giro: si memorizza la pagina, nessun avviso
    if (prev === hash) return { changed: false, state: { ...next, text: prevText || kept } };
    const old = new Set(prevText.split('\n'));
    const added = lines.filter((l) => !old.has(l));
    return {
      changed: true,
      state: next,
      diff: `Righe nuove o cambiate nella pagina ${check.url}:\n${added.join('\n').slice(0, 3_000)}`,
    };
  }
  const items = feedItems(raw);
  if (!items.length && !/<(rss|feed|rdf)/i.test(raw))
    throw new CheckSourceError('non sembra un feed RSS o Atom');
  const seen = Array.isArray(state?.seen) ? (state.seen as string[]) : null;
  const ids = items.map((i) => i.id);
  const next = { seen: ids.slice(0, 200), checkedAt: new Date().toISOString() };
  if (!seen) return { changed: false, state: next }; // primo giro: si segnano come viste le voci attuali
  const fresh = items.filter((i) => !seen.includes(i.id));
  if (!fresh.length)
    return {
      changed: false,
      state: { ...next, seen: [...new Set([...ids, ...seen])].slice(0, 200) },
    };
  return {
    changed: true,
    state: { ...next, seen: [...new Set([...ids, ...seen])].slice(0, 200) },
    diff: `Voci nuove nel feed ${check.url}:\n${fresh
      .slice(0, 15)
      .map((i) => `- ${i.title} ${i.link}`)
      .join('\n')
      .slice(0, 3_000)}`,
  };
}
