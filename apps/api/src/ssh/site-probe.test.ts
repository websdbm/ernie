import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  cancel: vi.fn(),
  request: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4 = mocks.resolve4;
    resolve6 = mocks.resolve6;
    cancel = mocks.cancel;
  },
}));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));

import { domainOf, probeSite, publicProbeAddress } from './site-probe.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve4.mockResolvedValue(['93.184.216.34']);
  mocks.resolve6.mockResolvedValue([]);
  mocks.request.mockImplementation((_opts, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (e: Error) => void;
    };
    req.end = () => callback({ statusCode: 302, destroy: vi.fn() });
    req.destroy = (e) => req.emit('error', e);
    return req;
  });
});
describe('bounded public site probe', () => {
  it('normalizes hosts, rejects credentials, ports, shell fragments and non-http protocols', () => {
    expect(domainOf('HTTPS://WWW.Example.IT/a?secret=x')).toBe('www.example.it');
    for (const input of [
      'ssh://example.it',
      'https://user:pw@example.it',
      'example.it:8080',
      'example.it;id',
      'localhost',
      '127.0.0.1',
    ])
      expect(domainOf(input)).toBeNull();
  });
  it('blocks private, loopback, link local and Tailscale addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.1.1',
      '100.91.204.102',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
    ])
      expect(publicProbeAddress(ip)).toBe(false);
    expect(publicProbeAddress('93.184.216.34')).toBe(true);
  });
  it('checks all DNS answers and makes no request if any are private', async () => {
    mocks.resolve6.mockResolvedValue(['::1']);
    expect((await probeSite('example.it')).dns.status).toBe('blocked');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('reports DNS failure independently from SSH without any HTTP request', async () => {
    mocks.resolve4.mockRejectedValue(new Error('NXDOMAIN'));
    expect((await probeSite('example.it')).dns.status).toBe('failed');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins IP, preserves Host/TLS identity, uses HEAD root and does not follow redirects', async () => {
    const result = await probeSite('example.it');
    expect(result.https.status).toBe(302);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    for (const [opts] of mocks.request.mock.calls) {
      expect(opts).toMatchObject({
        hostname: 'example.it',
        path: '/',
        method: 'HEAD',
        agent: false,
        family: 4,
      });
      const cb = vi.fn();
      opts.lookup('ignored-new-dns', {}, cb);
      expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    }
  });
});
