import { once } from 'node:events';
import { SshServer } from '@ernie/protocol';
import ssh2, { type Server as SshTestServer } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allowedSshPort } from './ssh/types.js';
import {
  allowedSshAddress,
  createSshTransport,
  redactSshOutput,
  resolveSshHost,
  sshFingerprint,
} from './ssh-transport.js';

const { Server, utils } = ssh2;

describe('SSH transport with real handshake', () => {
  const hostKeys = utils.generateKeyPairSync('ed25519');
  const accountKeys = utils.generateKeyPairSync('ed25519');
  const fingerprint = sshFingerprint(Buffer.from(hostKeys.public.split(' ')[1] ?? '', 'base64'));
  let server: SshTestServer;
  let port: number;
  let executions = 0;
  const transport = createSshTransport({
    resolveHost: async () => '127.0.0.1',
    timeoutMs: 1500,
    maxOutputBytes: 100,
  });
  const target = () =>
    SshServer.parse({
      id: '77349c82-55e5-4c6c-befb-ce0dc0744d68',
      name: 'Fixture',
      host: 'fixture.example',
      port,
      username: 'test',
      provider: null,
      providerInstanceId: null,
      fingerprint,
      revision: 1,
      lastCheckedAt: null,
      lastStatus: null,
    });
  beforeAll(async () => {
    server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
      client.on('error', () => {});
      client
        .on('authentication', (ctx) => {
          if (
            ctx.method === 'publickey' &&
            ctx.key.data.equals(Buffer.from(accountKeys.public.split(' ')[1] ?? '', 'base64'))
          )
            ctx.accept();
          else ctx.reject();
        })
        .on('ready', () =>
          client.on('session', (accept) => {
            const session = accept();
            session.on('exec', (accept, _reject, info) => {
              executions++;
              const stream = accept();
              if (info.command === 'wait') return;
              stream.write(info.command === 'huge' ? 'x'.repeat(300) : 'fixture-ok');
              stream.exit(0);
              stream.end();
            });
          }),
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());
  it('creates distinct Ed25519 keys, probes without authentication then pins host', async () => {
    const a = await transport.generateKey(),
      b = await transport.generateKey();
    expect(a.publicKey).toMatch(/^ssh-ed25519 /);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(await transport.probe(target())).toEqual({ fingerprint });
    expect(executions).toBe(0);
    expect((await transport.run(target(), accountKeys.private, 'uptime')).stdout).toBe(
      'fixture-ok',
    );
  });
  it('rejects changed host fingerprint before executing any command', async () => {
    const n = executions;
    await expect(
      transport.run(
        { ...target(), fingerprint: `SHA256:${'x'.repeat(43)}` },
        accountKeys.private,
        'uptime',
      ),
    ).rejects.toThrow('impronta');
    expect(executions).toBe(n);
  });
  it('bounds output and cancels a stalled command without replay', async () => {
    expect(await transport.run(target(), accountKeys.private, 'huge')).toMatchObject({
      stdout: 'x'.repeat(100),
      truncated: true,
    });
    const c = new AbortController(),
      n = executions;
    const result = transport.run(target(), accountKeys.private, 'wait', c.signal);
    setTimeout(() => c.abort(), 200);
    await expect(result).rejects.toThrow('interrotta');
    expect(executions).toBeLessThanOrEqual(n + 1);
  });
});
it('blocks loopback, private networks, metadata and mapped addresses, allows public addresses', async () => {
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '172.18.0.3',
    '10.1.2.3',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe80::1',
    'fc00::1',
    '0.0.0.0',
    '224.0.0.1',
    '192.0.0.8',
    '198.18.0.1',
    '198.19.255.254',
  ])
    expect(allowedSshAddress(address), address).toBe(false);
  expect(allowedSshAddress('8.8.8.8')).toBe(true);
  expect(allowedSshAddress('198.20.0.1')).toBe(true);
  await expect(resolveSshHost('localhost')).rejects.toThrow('riservato');
});
it('admits the Tailscale range only with owner network access, also after DNS resolution', async () => {
  expect(allowedSshAddress('100.91.204.102')).toBe(false);
  expect(allowedSshAddress('100.91.204.102', { tailnet: false })).toBe(false);
  expect(allowedSshAddress('100.91.204.102', { tailnet: true })).toBe(true);
  // Anche il titolare resta fuori dalle reti private vere e proprie.
  expect(allowedSshAddress('10.0.0.1', { tailnet: true })).toBe(false);
  const lookup = async () => [{ address: '100.101.102.103' }];
  await expect(
    resolveSshHost('box.tailnet.example', { tailnet: false }, { lookup }),
  ).rejects.toMatchObject({ code: 'address_not_allowed' });
  await expect(resolveSshHost('box.tailnet.example', { tailnet: true }, { lookup })).resolves.toBe(
    '100.101.102.103',
  );
  await expect(resolveSshHost('100.101.102.103')).rejects.toMatchObject({
    code: 'address_not_allowed',
  });
});
it('stops waiting for a stalled DNS lookup', async () => {
  const started = Date.now();
  await expect(
    resolveSshHost(
      'slow.example',
      { tailnet: false },
      {
        lookup: () => new Promise(() => {}),
        timeoutMs: 30,
      },
    ),
  ).rejects.toMatchObject({ code: 'dns_failed' });
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(
    resolveSshHost(
      'missing.example',
      { tailnet: false },
      {
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'dns_failed' });
});
it('refuses privileged non-SSH ports before resolving or connecting', async () => {
  const resolveHost = vi.fn(async () => '203.0.113.5');
  const transport = createSshTransport({ resolveHost });
  const server = SshServer.parse({
    id: '77349c82-55e5-4c6c-befb-ce0dc0744d68',
    name: 'Web',
    host: 'web.example',
    port: 80,
    username: 'root',
    provider: null,
    providerInstanceId: null,
    fingerprint: 'SHA256:fixed',
    revision: 1,
    lastCheckedAt: null,
    lastStatus: null,
  });
  await expect(transport.probe(server)).rejects.toMatchObject({ code: 'port_not_allowed' });
  await expect(transport.run(server, 'key', 'uptime')).rejects.toMatchObject({
    code: 'port_not_allowed',
  });
  expect(resolveHost).not.toHaveBeenCalled();
  for (const port of [22, 1024, 2222, 65535]) expect(allowedSshPort(port), String(port)).toBe(true);
  for (const port of [0, 21, 23, 80, 443, 1023, 65536]) expect(allowedSshPort(port)).toBe(false);
});
it('redacts secrets from output before persistence', () => {
  const text = redactSshOutput(
    'password=foo api_key=bar Bearer tokenvalue\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
  );
  for (const secret of ['foo', 'bar', 'tokenvalue', 'secret']) expect(text).not.toContain(secret);
});
