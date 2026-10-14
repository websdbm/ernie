import { describe, expect, it } from 'vitest';
import {
  CheckSourceError,
  evaluateCheck,
  feedItems,
  isPrivateAddress,
  pageText,
} from './checks.js';

const page = (body: string) =>
  `<html><head><script>var x=1</script><style>p{}</style></head><body><nav>menu</nav><h1>Versioni</h1>${body}<footer>© 2026</footer></body></html>`;

function fakeFetch(responses: string[], status = 200) {
  let i = 0;
  return (async () =>
    new Response(responses[Math.min(i++, responses.length - 1)], {
      status,
    })) as unknown as typeof fetch;
}
const publicDns = async () => ['93.184.216.34'];

describe('controlli economici', () => {
  it('niente rete interna: localhost, reti private, metadati cloud, nomi che risolvono dentro', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '100.91.204.102',
      '::1',
      'fd00::1',
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    const check = { type: 'page_changed' as const, url: 'http://localhost:18120/health' };
    await expect(
      evaluateCheck(check, null, { fetch: fakeFetch(['x']), resolve: publicDns }),
    ).rejects.toBeInstanceOf(CheckSourceError);
    await expect(
      evaluateCheck({ type: 'page_changed', url: 'https://trappola.example/' }, null, {
        fetch: fakeFetch(['x']),
        resolve: async () => ['10.0.0.5'],
      }),
    ).rejects.toThrow('indirizzo interno');
  });

  it('pagina: primo giro memorizza e fa valutare il contenuto attuale; uguale → niente; cambiata → diff delle righe nuove', async () => {
    const check = { type: 'page_changed' as const, url: 'https://esempio.it/versioni' };
    const deps = { resolve: publicDns };
    const r1 = await evaluateCheck(check, null, {
      ...deps,
      fetch: fakeFetch([page('<p>1.9 uscita</p>')]),
    });
    expect(r1.changed).toBe(true);
    expect(r1.diff).toContain('Primo controllo');
    const r2 = await evaluateCheck(check, r1.state, {
      ...deps,
      fetch: fakeFetch([page('<p>1.9 uscita</p>')]),
    });
    expect(r2.changed).toBe(false);
    const r3 = await evaluateCheck(check, r2.state, {
      ...deps,
      fetch: fakeFetch([page('<p>2.0 uscita oggi</p><p>1.9 uscita</p>')]),
    });
    expect(r3.changed).toBe(true);
    expect(r3.diff).toContain('2.0 uscita oggi');
    expect(r3.diff).not.toContain('1.9 uscita\n');
    expect(pageText(page('<p>ciao</p>'))).toEqual(['Versioni', 'ciao']);
  });

  it('feed: primo giro fa valutare le voci attuali, poi solo le nuove; errore della fonte = errore, non cambiamento', async () => {
    const rss = (items: string[]) =>
      `<rss><channel>${items.map((t) => `<item><title>${t}</title><link>https://x.it/${t}</link><guid>${t}</guid></item>`).join('')}</channel></rss>`;
    expect(feedItems(rss(['a', 'b'])).map((i) => i.id)).toEqual(['a', 'b']);
    const check = { type: 'feed_new_items' as const, url: 'https://x.it/feed' };
    const r1 = await evaluateCheck(check, null, {
      resolve: publicDns,
      fetch: fakeFetch([rss(['a', 'b'])]),
    });
    expect(r1.changed).toBe(true);
    expect(r1.diff).toContain('Primo controllo');
    const r2 = await evaluateCheck(check, r1.state, {
      resolve: publicDns,
      fetch: fakeFetch([rss(['c', 'a', 'b'])]),
    });
    expect(r2.changed).toBe(true);
    expect(r2.diff).toContain('- c https://x.it/c');
    await expect(
      evaluateCheck(check, r2.state, { resolve: publicDns, fetch: fakeFetch(['errore'], 503) }),
    ).rejects.toThrow('503');
  });
});
