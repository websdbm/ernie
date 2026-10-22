import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
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

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');

/** BlockList normalizza anche gli IPv4 mapped, senza dipendere dalla scrittura dell'indirizzo. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  return !family || blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const MAX_SOURCE_BYTES = 2_000_000;
const headers = {
  'user-agent': 'Ernie-sentinella/1.0',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
};

function checkStatus(status: number): void {
  if (status >= 300 && status < 400) throw new CheckSourceError(`redirect non seguito (${status})`);
  if (status < 200 || status >= 300) throw new CheckSourceError(`la fonte ha risposto ${status}`);
}

async function boundedText(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > MAX_SOURCE_BYTES) throw new CheckSourceError('fonte troppo grande');
    buffers.push(Buffer.from(chunk));
  }
  return Buffer.concat(buffers).toString('utf8');
}

/** Il socket usa esclusivamente gli indirizzi verificati, senza una seconda risoluzione DNS. */
function pinnedGet(url: URL, addresses: string[], signal: AbortSignal): Promise<string> {
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    const entries = addresses.map((address) => ({ address, family: isIP(address) }));
    if (options.all) callback(null, entries);
    else {
      const first = entries[0];
      if (!first) callback(new Error('nome non risolto'), '', 0);
      else callback(null, first.address, first.family);
    }
  };
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(
      url,
      {
        signal,
        lookup: pinnedLookup,
        headers,
      },
      (response) => {
        void (async () => {
          try {
            checkStatus(response.statusCode ?? 0);
            const encoding = response.headers['content-encoding']?.toLowerCase();
            const decoder =
              encoding === 'gzip'
                ? createGunzip()
                : encoding === 'deflate'
                  ? createInflate()
                  : encoding === 'br'
                    ? createBrotliDecompress()
                    : null;
            if (encoding && encoding !== 'identity' && !decoder)
              throw new CheckSourceError('codifica della fonte non supportata');
            if (decoder) response.on('error', (error) => decoder.destroy(error));
            try {
              resolve(await boundedText(decoder ? response.pipe(decoder) : response));
            } finally {
              decoder?.destroy();
            }
          } catch (error) {
            reject(error);
          } finally {
            response.destroy();
            request.destroy();
          }
        })();
      },
    );
    request.on('error', reject);
  });
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
    if (!deps.fetch) return await pinnedGet(u, addrs, ac.signal);
    const res = await deps.fetch(u, { signal: ac.signal, redirect: 'manual', headers });
    try {
      checkStatus(res.status);
      if (!res.body) return '';
      return await boundedText(res.body);
    } finally {
      if (res.body && !res.body.locked) await res.body.cancel().catch(() => {});
    }
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
    // Primo giro: si memorizza la pagina e il modello valuta subito la condizione sul contenuto attuale
    // (una condizione già vera alla creazione va segnalata, 14 ott 2026).
    if (!prev)
      return {
        changed: true,
        state: next,
        diff: `Primo controllo della pagina ${check.url} (contenuto attuale):\n${kept.slice(0, 3_000)}`,
      };
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
  // Primo giro: le voci attuali si segnano come viste e il modello le valuta subito.
  if (!seen)
    return {
      changed: true,
      state: next,
      diff: `Primo controllo del feed ${check.url} (voci attuali):\n${items
        .slice(0, 15)
        .map((i) => `- ${i.title} ${i.link}`)
        .join('\n')
        .slice(0, 3_000)}`,
    };
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
