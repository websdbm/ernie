import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import http2 from 'node:http2';
import type { Logger } from '@ernie/observability';
import type { DeviceRepository } from './devices.js';

export interface ApnsConfig {
  readonly teamId: string;
  readonly keyId: string;
  /** Chiave privata .p8 in PEM (le sequenze "\n" letterali vengono convertite). */
  readonly privateKey: string;
  readonly bundleId: string;
}

export const APNS_HOSTS = {
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;
export type ApnsEnvironment = keyof typeof APNS_HOSTS;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT ES256 per APNs (token-based auth): header {alg, kid}, claims {iss, iat}; firma in formato raw r||s. */
export function createApnsJwt(
  cfg: ApnsConfig,
  key: KeyObject,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSeconds }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${b64url(signature)}`;
}

export function parseApnsPrivateKey(pem: string): KeyObject {
  return createPrivateKey({ key: pem.replace(/\\n/g, '\n'), format: 'pem' });
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Dati applicativi recapitati all'app (chiave `ernie` nel payload). */
  readonly data?: Record<string, unknown>;
  readonly badge?: number;
  readonly threadId?: string;
}

/** Payload APNs: alert visibile, suono predefinito, `content-available` per il refresh, dati sotto `ernie`. */
export function buildApnsPayload(msg: PushMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: msg.title.slice(0, 120), body: msg.body.slice(0, 1000) },
      sound: 'default',
      ...(msg.badge === undefined ? {} : { badge: msg.badge }),
      ...(msg.threadId ? { 'thread-id': msg.threadId } : {}),
      'mutable-content': 1,
    },
    ernie: msg.data ?? {},
  };
}

export interface ApnsResult {
  readonly status: number;
  readonly reason?: string;
  /** Il token non è più valido: il dispositivo va rimosso. */
  readonly unregistered: boolean;
}

export interface ApnsClient {
  send(token: string, environment: ApnsEnvironment, msg: PushMessage): Promise<ApnsResult>;
  close(): Promise<void>;
}

/** Client HTTP/2 verso APNs con JWT rinnovato ogni 50 minuti e una sessione per ambiente. */
export function createApnsClient(
  cfg: ApnsConfig,
  logger: Pick<Logger, 'warn' | 'debug'>,
): ApnsClient {
  const key = parseApnsPrivateKey(cfg.privateKey);
  let jwt: { value: string; issuedAt: number } | null = null;
  const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();

  const token = (): string => {
    const now = Math.floor(Date.now() / 1000);
    if (!jwt || now - jwt.issuedAt > 50 * 60)
      jwt = { value: createApnsJwt(cfg, key, now), issuedAt: now };
    return jwt.value;
  };
  const session = (env: ApnsEnvironment): http2.ClientHttp2Session => {
    const existing = sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(APNS_HOSTS[env]);
    s.on('error', (err) => {
      logger.warn({ err: err.message, env }, 'sessione APNs in errore');
      sessions.delete(env);
    });
    s.on('goaway', () => sessions.delete(env));
    sessions.set(env, s);
    return s;
  };

  return {
    send(deviceToken, env, msg) {
      return new Promise<ApnsResult>((resolve) => {
        const body = JSON.stringify(buildApnsPayload(msg));
        const req = session(env).request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${token()}`,
          'apns-topic': cfg.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': '0',
          'content-type': 'application/json',
        });
        let status = 0;
        let data = '';
        req.setEncoding('utf8');
        req.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        req.on('data', (chunk: string) => {
          data += chunk;
        });
        req.on('error', (err) => resolve({ status: 0, reason: err.message, unregistered: false }));
        req.on('end', () => {
          let reason: string | undefined;
          try {
            reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
          } catch {
            reason = data || undefined;
          }
          const unregistered =
            status === 410 ||
            reason === 'BadDeviceToken' ||
            reason === 'Unregistered' ||
            reason === 'DeviceTokenNotForTopic';
          resolve({ status, ...(reason ? { reason } : {}), unregistered });
        });
        req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
        req.end(body);
      });
    },
    async close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

export interface PushSender {
  /** Invia a tutti i dispositivi dell'utente; rimuove i token che APNs dichiara non più validi. */
  notifyUser(
    userId: string,
    msg: PushMessage,
  ): Promise<{ sent: number; failed: number; removed: number }>;
  close(): Promise<void>;
}

export function createPushSender(deps: {
  readonly apns: ApnsClient;
  readonly devices: DeviceRepository;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
}): PushSender {
  return {
    async notifyUser(userId, msg) {
      const devices = await deps.devices.list(userId);
      let sent = 0;
      let failed = 0;
      let removed = 0;
      for (const d of devices) {
        const res = await deps.apns.send(d.token, d.environment, msg);
        if (res.status === 200) sent++;
        else {
          failed++;
          deps.logger.warn(
            { status: res.status, reason: res.reason, env: d.environment },
            'push APNs non consegnata',
          );
          if (res.unregistered && (await deps.devices.remove(userId, d.token))) removed++;
        }
      }
      if (devices.length) deps.logger.info({ userId, sent, failed, removed }, 'push inviate');
      return { sent, failed, removed };
    },
    close: () => deps.apns.close(),
  };
}
