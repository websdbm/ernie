import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList } from 'node:net';
import { allowedSshAddress } from '../ssh-transport.js';

const privateOverlay = new BlockList();
privateOverlay.addSubnet('100.64.0.0', 10, 'ipv4');
export function publicProbeAddress(address: string): boolean {
  return allowedSshAddress(address) && !privateOverlay.check(address, 'ipv4');
}
export function domainOf(value: string): string | null {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}
export interface SiteProbe {
  dns: {
    status: 'ok' | 'failed' | 'blocked';
    addresses: string[];
    queries?: { type: 'A' | 'AAAA'; status: 'answered' | 'failed'; error: string | null }[];
  };
  http: { status: number | null; error: string | null };
  https: { status: number | null; error: string | null };
  limitations: string[];
}
/** Only the registered hostname, root path, HEAD, no credentials, body or redirects.
 * DNS is resolved once and every connection is pinned to that public address. */
export async function probeSite(domain: string, signal?: AbortSignal): Promise<SiteProbe> {
  const resolver = new Resolver({ timeout: 2500, tries: 1 });
  const cancel = () => resolver.cancel();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  let addresses: string[];
  let queries: NonNullable<SiteProbe['dns']['queries']>;
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(domain),
      resolver.resolve6(domain),
    ]);
    addresses = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    queries = results.map((result, index) => {
      const code = result.status === 'rejected' ? result.reason?.code : null;
      return {
        type: index === 0 ? 'A' : 'AAAA',
        status: result.status === 'fulfilled' ? 'answered' : 'failed',
        error:
          result.status === 'fulfilled'
            ? null
            : typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
              ? code
              : 'DNS_QUERY_FAILED',
      };
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  signal?.throwIfAborted();
  const empty = { status: null, error: 'non_eseguito' };
  const limitations = [
    'Verifica esterna dal backend Ernie, solo HEAD alla radice; nessun redirect seguito.',
    'HTTP 200 su HEAD prova soltanto la risposta alla richiesta: corpo della pagina, rendering, login, moduli e funzionamento applicativo non verificati.',
    'Per risposte 3xx la destinazione del reindirizzamento non è stata verificata; non presumere HTTPS.',
    'DNS diversi dall’IP del server possono indicare CDN o proxy, non necessariamente un errore.',
    'DNS failed descrive solo il risultato del resolver del backend, non una causa accertata del disservizio: confrontare codici delle query e risposte indipendenti prima di concludere. DNS blocked è un limite di sicurezza del probe.',
  ];
  if (!addresses.length || addresses.some((a) => !publicProbeAddress(a)))
    return {
      dns: { status: addresses.length ? 'blocked' : 'failed', addresses, queries },
      http: empty,
      https: empty,
      limitations,
    };
  const address = addresses[0] as string;
  const head = (tls: boolean): Promise<SiteProbe['http']> =>
    new Promise((resolve) => {
      const req = (tls ? httpsRequest : httpRequest)(
        {
          hostname: domain,
          port: tls ? 443 : 80,
          method: 'HEAD',
          path: '/',
          agent: false,
          family: address.includes(':') ? 6 : 4,
          signal,
          headers: { 'User-Agent': 'Ernie-Diagnostics/1.0' },
          lookup: (_host, _options, cb) => cb(null, address, address.includes(':') ? 6 : 4),
        },
        (res) => {
          clearTimeout(timer);
          res.destroy();
          resolve({ status: res.statusCode ?? null, error: null });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('probe_timeout')), 8000);
      req.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ status: null, error: error.code ?? 'probe_failed_or_timeout' });
      });
      req.end();
    });
  const [http, https] = await Promise.all([head(false), head(true)]);
  return { dns: { status: 'ok', addresses, queries }, http, https, limitations };
}
