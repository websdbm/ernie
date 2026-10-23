import { randomUUID } from 'node:crypto';
import { type SshServer, type SshSite, SshSnapshot } from '@ernie/protocol';
import { describe, expect, it, vi } from 'vitest';
import { investigateSite } from './runbook.js';
import type { SshService } from './service.js';
import type { probeSite } from './site-probe.js';

const user = randomUUID(),
  serverId = randomUUID(),
  siteId = randomUUID();
function setup() {
  const snapshot = SshSnapshot.parse({
    configured: true,
    key: null,
    servers: [
      {
        id: serverId,
        name: 'Server A',
        host: '203.0.113.9',
        port: 22,
        username: 'root',
        provider: null,
        providerInstanceId: null,
        fingerprint: 'SHA256:fixed',
        revision: 1,
        lastCheckedAt: null,
        lastStatus: null,
      },
    ],
    sites: [
      {
        id: siteId,
        serverId,
        name: 'Example',
        url: 'https://example.it',
        path: '/httpdocs',
        container: '',
      },
    ],
    providers: [],
    operations: [],
  });
  const service = {
    snapshot: vi.fn(async () => snapshot),
    diagnose: vi.fn(async (_user: string, _input: { serverId: string; check: string }) => ({
      output: 'Codice uscita: 0\nok',
    })),
    providerInstances: vi.fn(async () => ({
      instances: [
        { id: 'own-instance', status: 'running' },
        { id: 'other-instance', status: 'stopped' },
      ],
    })),
  };
  const probe = vi.fn<typeof probeSite>(async () => ({
    dns: { status: 'ok', addresses: ['203.0.113.9'] },
    http: { status: 301, error: null },
    https: { status: 503, error: null },
    limitations: [],
  }));
  const run = (input = { domain: 'example.it' }, signal?: AbortSignal) =>
    investigateSite(service as unknown as SshService, user, input, signal, probe);
  return { snapshot, service, probe, run };
}
describe('account scoped site runbook', () => {
  it('maps exact registered domain, collects bounded checks and never proposes health from a completed run', async () => {
    const { run, service, probe } = setup();
    const result = await run({ domain: 'https://EXAMPLE.it/sensitive?token=ignored' });
    expect(result.status).toBe('complete');
    expect(result.checks.map((c) => c.check)).toEqual([
      'dns_http_tls',
      'overview',
      'disk',
      'services',
    ]);
    expect(result.checks[0]?.output).toContain('503');
    expect(probe).toHaveBeenCalledWith('example.it', undefined);
    expect(service.snapshot).toHaveBeenCalledWith(user);
    expect(service.diagnose.mock.calls.map((args) => args.slice(0, 2))).toEqual(
      ['overview', 'disk', 'services'].map((check) => [user, { serverId, check }]),
    );
    expect(service.providerInstances).not.toHaveBeenCalled();
    expect(result.guidance).toContain('NON sito sano');
  });
  it('does not connect to an unknown domain or a credential-bearing URL', async () => {
    const { run, service, probe } = setup();
    expect((await run({ domain: 'example.it.evil.org' })).status).toBe('not_found');
    expect((await run({ domain: 'https://user:secret@example.it/' })).status).toBe(
      'invalid_domain',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(service.diagnose).not.toHaveBeenCalled();
  });
  it('asks before connecting to ambiguous registrations, rejects cross-account site IDs', async () => {
    const { run, snapshot, service, probe } = setup();
    snapshot.sites.push({ ...(snapshot.sites[0] as SshSite), id: randomUUID(), name: 'Duplicate' });
    expect((await run()).status).toBe('needs_selection');
    expect((await run({ domain: 'example.it', siteId: randomUUID() } as never)).status).toBe(
      'needs_selection',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(service.diagnose).not.toHaveBeenCalled();
    expect((await run({ domain: 'example.it', siteId } as never)).status).toBe('complete');
  });
  it('only falls back to www when an exact registration is absent', async () => {
    const { run, snapshot, probe } = setup();
    await run({ domain: 'www.example.it' });
    expect(probe).toHaveBeenLastCalledWith('example.it', undefined);
    snapshot.sites.push({
      ...(snapshot.sites[0] as SshSite),
      id: randomUUID(),
      url: 'https://www.example.it',
    });
    const result = await run({ domain: 'www.example.it' });
    expect(result.candidateCount).toBe(1);
    expect(probe).toHaveBeenLastCalledWith('www.example.it', undefined);
  });
  it('stops SSH followups on failure, reads only the explicitly associated provider instance', async () => {
    const { run, service, snapshot } = setup();
    (snapshot.servers[0] as SshServer).provider = 'vultr';
    (snapshot.servers[0] as SshServer).providerInstanceId = 'own-instance';
    snapshot.providers.push({ provider: 'vultr', connected: true, lastCheckedAt: null });
    service.diagnose.mockRejectedValue(new Error('password=do-not-leak'));
    const result = await run();
    expect(service.diagnose).toHaveBeenCalledTimes(1);
    expect(service.providerInstances).toHaveBeenCalledWith(user, 'vultr');
    expect(result.status).toBe('partial');
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
    expect(JSON.stringify(result)).not.toContain('other-instance');
  });
  it('keeps failed services unresolved even when HTTPS 200 and SSH succeed', async () => {
    const { run, service, probe } = setup();
    probe.mockResolvedValue({
      dns: { status: 'ok', addresses: ['203.0.113.9'] },
      http: { status: 301, error: null },
      https: { status: 200, error: null },
      limitations: [],
    });
    service.diagnose.mockImplementation(async (_user, input) => ({
      output:
        input.check === 'services'
          ? 'Codice uscita: 0\nUNIT LOAD ACTIVE SUB DESCRIPTION\napache2.service loaded active running Apache\n● systemd-networkd-wait-online.service loaded failed failed Wait for network\nworker.service loaded failed failed Worker\n'
          : 'Codice uscita: 0\nok',
    }));
    const report = await run();
    expect(report.status).toBe('complete'); // Collection completed, not system health.
    expect(report.unresolvedFindings).toEqual([
      {
        unit: 'systemd-networkd-wait-online.service',
        observedState: 'failed',
        cause: 'not_verified',
        impact: 'not_verified',
      },
      {
        unit: 'worker.service',
        observedState: 'failed',
        cause: 'not_verified',
        impact: 'not_verified',
      },
    ]);
    expect(report.unresolvedFindings.some((f) => f.unit === 'apache2.service')).toBe(false);
    expect(service.providerInstances).not.toHaveBeenCalled();
  });
  it('cancellation prevents subsequent SSH checks', async () => {
    const { run, service } = setup();
    const ac = new AbortController();
    service.diagnose.mockImplementation(async () => {
      ac.abort();
      return { output: 'Codice uscita: 0\nok' };
    });
    await expect(run(undefined, ac.signal)).rejects.toThrow();
    expect(service.diagnose).toHaveBeenCalledTimes(1);
  });
});
