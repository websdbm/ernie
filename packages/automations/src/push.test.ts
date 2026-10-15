import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApnsPayload, createApnsJwt, parseApnsPrivateKey } from './push.js';

describe('APNs: JWT ES256 e payload', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cfg = {
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    privateKey: pem.replace(/\n/g, '\\n'),
    bundleId: 'com.websdbm.ernie',
  };

  it('firma verificabile con la chiave pubblica, header e claims come richiesto da Apple', () => {
    const key = parseApnsPrivateKey(cfg.privateKey);
    const jwt = createApnsJwt(cfg, key, 1_760_000_000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: 'TEAM123456',
      iat: 1_760_000_000,
    });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
    expect(Buffer.from(s, 'base64url')).toHaveLength(64);
  });

  it('il payload ha alert, suono e dati applicativi sotto `ernie`', () => {
    const p = buildApnsPayload({
      title: 'Ricette della settimana',
      body: 'Serve la tua approvazione',
      data: { runId: 'r1', kind: 'automation.approval' },
      threadId: 'automations',
    });
    expect(p).toMatchObject({
      aps: {
        alert: { title: 'Ricette della settimana', body: 'Serve la tua approvazione' },
        sound: 'default',
        'thread-id': 'automations',
        'mutable-content': 1,
      },
      ernie: { runId: 'r1', kind: 'automation.approval' },
    });
    expect((p.aps as Record<string, unknown>)['interruption-level']).toBeUndefined();
  });

  it('messaggi in famiglia: urgenti (in cima al blocco) e con la categoria delle azioni', () => {
    const p = buildApnsPayload({
      title: '✉️ papà',
      body: 'Arrivo',
      data: { kind: 'family_message', id: 'm1' },
      threadId: 'family-u1',
      interruptionLevel: 'time-sensitive',
      category: 'FAMILY_MESSAGE',
    });
    expect(p.aps).toMatchObject({
      'interruption-level': 'time-sensitive',
      category: 'FAMILY_MESSAGE',
      'thread-id': 'family-u1',
      'mutable-content': 1,
    });
  });
});
