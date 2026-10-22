import { once } from 'node:events';
import { SshServer } from '@ernie/protocol';
import ssh2, { type Server as SshTestServer } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
it('blocks loopback, private networks, metadata and mapped addresses, allows public and tailnet', async () => {
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
  ])
    expect(allowedSshAddress(address), address).toBe(false);
  expect(allowedSshAddress('100.91.204.102')).toBe(true);
  expect(allowedSshAddress('8.8.8.8')).toBe(true);
  await expect(resolveSshHost('localhost')).rejects.toThrow('riservato');
});
it('redacts secrets from output before persistence', () => {
  const text = redactSshOutput(
    'password=foo api_key=bar Bearer tokenvalue\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
  );
  for (const secret of ['foo', 'bar', 'tokenvalue', 'secret']) expect(text).not.toContain(secret);
});
