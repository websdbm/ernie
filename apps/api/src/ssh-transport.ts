import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { SshServer } from '@ernie/protocol';
import ssh2 from 'ssh2';
import { allowedSshPort, SshError, type SshNetworkAccess, type SshTransport } from './ssh/types.js';

const { Client, utils } = ssh2;
const denied4 = new BlockList(),
  denied6 = new BlockList(),
  tailnet4 = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied4.addSubnet(ip, bits, 'ipv4');
// Spazio CGNAT usato da Tailscale: rete interna, ammessa solo al titolare.
tailnet4.addSubnet('100.64.0.0', 10, 'ipv4');
for (const [ip, bits] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const)
  denied6.addSubnet(ip, bits, 'ipv6');
const strict: SshNetworkAccess = { tailnet: false };
export function allowedSshAddress(address: string, access: SshNetworkAccess = strict): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) return !denied6.check(address, 'ipv6');
  return !denied4.check(address, 'ipv4') && (access.tailnet || !tailnet4.check(address, 'ipv4'));
}
const DNS_TIMEOUT_MS = 5_000;
export async function resolveSshHost(
  host: string,
  access: SshNetworkAccess = strict,
  deps: {
    lookup?: (host: string) => Promise<{ address: string }[]>;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  if (!/^[a-zA-Z0-9:.-]+$/.test(host))
    throw new SshError('address_not_allowed', 'Indirizzo SSH non valido.');
  const resolve = deps.lookup ?? ((h: string) => lookup(h, { all: true, verbatim: true }));
  let timer: NodeJS.Timeout | undefined;
  let addresses: { address: string }[];
  try {
    // getaddrinfo non si interrompe: si smette di aspettarlo dopo il tempo massimo.
    addresses = isIP(host)
      ? [{ address: host }]
      : await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('dns timeout')),
              deps.timeoutMs ?? DNS_TIMEOUT_MS,
            );
          }),
        ]);
  } catch {
    throw new SshError(
      'dns_failed',
      'Nome del server non risolto o DNS troppo lento. Controlla l’indirizzo.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!addresses[0] || addresses.some((a) => !allowedSshAddress(a.address, access)))
    throw new SshError(
      'address_not_allowed',
      access.tailnet
        ? 'Indirizzo SSH locale o riservato non consentito. Usa un indirizzo pubblico o Tailscale.'
        : 'Indirizzo SSH locale, riservato o della rete interna non consentito. Usa un indirizzo pubblico.',
      403,
    );
  return addresses[0].address;
}
function checkedPort(port: number): number {
  if (!allowedSshPort(port))
    throw new SshError(
      'port_not_allowed',
      'Porta SSH non ammessa: usa la 22 o una porta da 1024 a 65535.',
      403,
    );
  return port;
}
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}
export function redactSshOutput(text: string): string {
  return (
    text
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        '[chiave privata nascosta]',
      )
      .replace(/\b(Bearer)\s+\S+/gi, '$1 [nascosto]')
      .replace(
        /((?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi,
        '$1[nascosto]',
      )
      .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/g, '$1[nascosto]@')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: remove remote terminal control characters
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  );
}
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** No shell, forwarding, agent or password fallback. DNS is pinned before connecting. */
export function createSshTransport(
  options: {
    resolveHost?: (host: string, access: SshNetworkAccess) => Promise<string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): SshTransport {
  const resolveHost = options.resolveHost ?? resolveSshHost;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const max = options.maxOutputBytes ?? 32_000;
  return {
    generateKey() {
      const key = utils.generateKeyPairSync('ed25519', { comment: 'Ernie' });
      const blob = Buffer.from(key.public.split(' ')[1] ?? '', 'base64');
      return { privateKey: key.private, publicKey: key.public, fingerprint: sshFingerprint(blob) };
    },
    async probe(server: SshServer, access = strict) {
      const port = checkedPort(server.port);
      const host = await resolveHost(server.host, access);
      return new Promise((resolve, reject) => {
        const client = new Client();
        let fingerprint: string | undefined;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          client.destroy();
          if (fingerprint) resolve({ fingerprint });
          else
            reject(
              new Error(
                'Impossibile leggere l’impronta SSH. Controlla indirizzo, porta e firewall.',
              ),
            );
        };
        const timer = setTimeout(finish, timeoutMs);
        client.on('error', finish).on('close', finish);
        client.connect({
          host,
          port,
          username: server.username,
          readyTimeout: timeoutMs,
          hostVerifier(key: Buffer) {
            fingerprint = sshFingerprint(key as Buffer);
            return false;
          },
          authHandler: () => false,
        });
      });
    },
    async run(server, privateKey, command, signal, access = strict) {
      if (!server.fingerprint) throw new Error('Verifica prima l’impronta del server.');
      const port = checkedPort(server.port);
      const host = await resolveHost(server.host, access);
      if (signal?.aborted) throw new Error('Operazione annullata.');
      return new Promise((resolve, reject) => {
        const client = new Client();
        let done = false;
        let mismatch = false;
        let used = 0;
        let truncated = false;
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          client.destroy();
        };
        const fail = (message: string) => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error(message));
        };
        const abort = () => fail('Operazione interrotta: verificare il server prima di ripetere.');
        const timer = setTimeout(
          () => fail('Tempo scaduto: l’esito remoto va verificato prima di ripetere.'),
          timeoutMs,
        );
        const collect = (dest: Buffer[], data: Buffer) => {
          const b = Buffer.from(data);
          const room = Math.max(0, max - used);
          if (b.length > room) truncated = true;
          if (room > 0) {
            dest.push(b.subarray(0, room));
            used += Math.min(room, b.length);
          }
        };
        signal?.addEventListener('abort', abort, { once: true });
        client.on('error', () =>
          fail(
            mismatch
              ? 'L’impronta SSH è cambiata. Connessione bloccata.'
              : 'Connessione SSH non riuscita. Controlla chiave, utente e accesso al server.',
          ),
        );
        client.on('close', () => {
          if (!done) fail('Connessione chiusa: verificare l’esito remoto.');
        });
        client.on('ready', () => {
          if (signal?.aborted) {
            abort();
            return;
          }
          client.exec(command, { pty: false }, (error, stream) => {
            if (error) {
              fail('Il server non ha accettato il comando.');
              return;
            }
            stream.on('data', (b: Buffer) => collect(out, b));
            stream.stderr.on('data', (b: Buffer) => collect(err, b));
            stream.on('error', () => fail('Esecuzione SSH interrotta.'));
            stream.on('close', (code: number | null) => {
              if (done) return;
              if (!Number.isInteger(code)) {
                fail('Il server non ha restituito l’esito del comando.');
                return;
              }
              done = true;
              cleanup();
              resolve({
                stdout: redactSshOutput(Buffer.concat(out).toString('utf8')),
                stderr: redactSshOutput(Buffer.concat(err).toString('utf8')),
                exitCode: code as number,
                truncated,
              });
            });
          });
        });
        client.connect({
          host,
          port,
          username: server.username,
          privateKey,
          readyTimeout: timeoutMs,
          keepaliveInterval: 10_000,
          keepaliveCountMax: 2,
          hostVerifier(key: Buffer) {
            const match = equal(sshFingerprint(key as Buffer), server.fingerprint ?? '');
            mismatch = !match;
            return match;
          },
          authHandler: ['publickey'],
        });
      });
    },
  };
}
