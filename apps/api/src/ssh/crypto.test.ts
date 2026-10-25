import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseMasterKey } from './crypto.js';
import {
  canonicalImportSource,
  diagnosticCommand,
  sanitizeSshOutput,
  shellQuote,
  wordpressCommand,
} from './service.js';

describe('SSH encrypted secrets and bounded command compilation', () => {
  it('authenticates owner and secret kind; rejects ciphertext tampering and malformed master keys', () => {
    const key = parseMasterKey(Buffer.alloc(32, 7).toString('base64'));
    if (!key) throw new Error('key');
    const a = randomUUID(),
      b = randomUUID(),
      secret = encryptSecret(key, a, 'provider:vultr', 'synthetic test secret');
    expect(decryptSecret(key, a, 'provider:vultr', secret)).toBe('synthetic test secret');
    expect(() => decryptSecret(key, b, 'provider:vultr', secret)).toThrow('decifrata');
    expect(() => decryptSecret(key, a, 'ssh-private', secret)).toThrow('decifrata');
    const altered = Buffer.from(secret.ciphertext, 'base64');
    altered[0] = (altered[0] ?? 0) ^ 1;
    expect(() =>
      decryptSecret(key, a, 'provider:vultr', {
        ...secret,
        ciphertext: altered.toString('base64'),
      }),
    ).toThrow('decifrata');
    expect(() => parseMasterKey('invalid')).toThrow('32 byte');
    expect(parseMasterKey(undefined)).toBeNull();
  });
  it('quotes configured WP paths and prevents target overrides or additional shell commands', () => {
    const site = {
      id: randomUUID(),
      serverId: randomUUID(),
      name: 'Sito',
      url: 'https://example.test',
      path: "/var/www/a'quoted",
      container: 'wp-app',
    };
    const command = wordpressCommand(site, 'plugin list --format=json');
    expect(command).toContain(`docker exec 'wp-app' wp --path=${shellQuote(site.path)}`);
    expect(command).toContain("'plugin' 'list' '--format=json'");
    expect(wordpressCommand(site, 'config get WP_DEBUG')).toContain("'WP_DEBUG'");
    for (const args of [
      'plugin list; rm -rf /',
      "'--ssh=other' core version",
      '--path=/else core version',
      'core version | cat',
      'config get DB_PASSWORD',
      'config get AUTH_KEY',
    ])
      expect(() => wordpressCommand(site, args)).toThrow();
    expect(() =>
      wordpressCommand({ ...site, container: '--privileged' }, 'core version'),
    ).toThrow();
    expect(() => diagnosticCommand({ serverId: site.serverId, check: 'wordpress' }, null)).toThrow(
      'Seleziona',
    );
    expect(diagnosticCommand({ serverId: site.serverId, check: 'disk' }, null)).toBe(
      'df -hP; df -iP',
    );
  });
  it('redacts private keys, known secrets, credential assignments and bearer tokens', () => {
    const output = sanitizeSshOutput(
      'password=synthetic-password\nDB_PASSWORD=db-secret\n{"client_secret":"json-secret"}\npostgres://user:db-pass@example.test/db\nAuthorization: Bearer synthetic-token\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----\nexact-secret',
      ['exact-secret'],
    );
    expect(output).not.toMatch(
      /synthetic-password|synthetic-token|private material|exact-secret|db-secret|json-secret|db-pass/,
    );
    expect(output).toContain('RIMOS');
  });
  it('redacts wp-config defines, env-style tokens, tabular config and URL tokens (revisione 25 ott 2026)', () => {
    const output = sanitizeSshOutput(
      [
        "define( 'DB_PASSWORD', 'wp-db-secret' );",
        "define('AUTH_SALT', 'salt-secret-value');",
        'GITHUB_TOKEN=ghp_synthetic',
        'DB_PASS: plain-pass',
        'DB_PASSWORD     table-secret     constant',
        '| SECURE_AUTH_KEY | key-secret | constant |',
        'GET /callback?token=url-secret&page=2',
        "define( 'WP_DEBUG', false );",
      ].join('\n'),
    );
    expect(output).not.toMatch(
      /wp-db-secret|salt-secret-value|ghp_synthetic|plain-pass|table-secret|key-secret|url-secret/,
    );
    expect(output).toContain("define( 'WP_DEBUG', false );");
    expect(output).toContain('page=2');
  });
  it('canonicalizes source instance namespaces without carrying credentials or query tokens', () => {
    expect(canonicalImportSource('https://HF.EXAMPLE.test/inventory/?token=secret#tab')).toBe(
      'https://hf.example.test/inventory',
    );
    expect(() => canonicalImportSource('https://user:secret@example.test')).toThrow();
    expect(() => canonicalImportSource('ftp://example.test')).toThrow();
  });
});
