import { type EventType, type PayloadInputOf, parseClientEvent } from '@ernie/protocol';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AuthContext, type Authenticator, extractBearer } from '../auth.js';
import { ClientConnection, type ConnectionDeps } from './connection.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface WsPluginOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly connection: ConnectionDeps;
  readonly path?: string;
  /** Registro delle connessioni per utente: consente di recapitare eventi fuori turno (es. automazioni). */
  readonly connections?: ConnectionRegistry;
}

/** Connessioni aperte per utente, in questo processo. */
export class ConnectionRegistry {
  private readonly byUser = new Map<string, Set<ClientConnection>>();

  add(conn: ClientConnection): void {
    const set = this.byUser.get(conn.userId) ?? new Set<ClientConnection>();
    set.add(conn);
    this.byUser.set(conn.userId, set);
  }

  remove(conn: ClientConnection): void {
    const set = this.byUser.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byUser.delete(conn.userId);
  }

  /** Recapita un evento a tutte le sessioni avviate dell'utente; restituisce quante lo hanno ricevuto. */
  async push<T extends EventType>(
    userId: string,
    type: T,
    payload: PayloadInputOf<T>,
  ): Promise<number> {
    let n = 0;
    for (const conn of this.byUser.get(userId) ?? []) {
      if (await conn.push(type, payload)) n++;
    }
    return n;
  }

  get size(): number {
    let n = 0;
    for (const s of this.byUser.values()) n += s.size;
    return n;
  }
}

/** Autenticazione e controllo Origin sull'upgrade; i client nativi non inviano Origin. */
export function createAuthHook(authenticator: Authenticator, allowedOrigins: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      await reply.code(403).send({ error: 'origin_not_allowed', message: 'Origin non consentita' });
      return;
    }
    const ctx = await authenticator.authenticate(extractBearer(request.headers.authorization));
    if (!ctx) {
      await reply
        .code(401)
        .send({ error: 'unauthorized', message: 'Chiave API mancante o non valida' });
      return;
    }
    request.auth = ctx;
  };
}

export async function registerWs(app: FastifyInstance, opts: WsPluginOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  // Mantiene turno, conferme e routing durante brevi perdite di rete del telefono.
  const sessions = new Map<string, { connection: ClientConnection; expiry?: NodeJS.Timeout }>();
  app.addHook('onClose', async () => {
    for (const entry of sessions.values()) {
      clearTimeout(entry.expiry);
      await entry.connection.close();
    }
    sessions.clear();
  });

  app.get(
    opts.path ?? '/v1/ws',
    { websocket: true, preValidation: createAuthHook(opts.authenticator, opts.allowedOrigins) },
    (socket, req) => {
      const auth = req.auth;
      if (!auth) {
        socket.close(1008, 'unauthorized');
        return;
      }
      let conn: ClientConnection | undefined;
      let key: string | undefined;
      socket.on('message', (data: Buffer | string) => {
        if (!conn) {
          try {
            const event = parseClientEvent(JSON.parse(data.toString()));
            if (event.type === 'session.start')
              key = `${auth.userId}:${auth.apiKeyId}:${event.sessionId}`;
          } catch {
            /* handleRaw restituisce l'errore del protocollo */
          }
          const entry = key ? sessions.get(key) : undefined;
          clearTimeout(entry?.expiry);
          conn = entry?.connection ?? new ClientConnection(socket, auth, opts.connection);
          conn.attach(socket, auth);
          if (key) sessions.set(key, { connection: conn });
          opts.connections?.add(conn);
        }
        conn
          .handleRaw(data)
          .catch((err: unknown) => req.log.error({ err }, 'messaggio WebSocket non gestito'));
      });
      socket.on('close', () => {
        if (!conn?.detach(socket)) return;
        opts.connections?.remove(conn);
        if (key) {
          const entry = sessions.get(key);
          const oldKey = key;
          if (entry) {
            entry.expiry = setTimeout(() => {
              sessions.delete(oldKey);
              void entry.connection.close();
            }, 10 * 60_000);
            entry.expiry.unref();
          }
        } else void conn.close();
      });
      socket.on('error', (err: Error) => {
        opts.connection.logger.warn({ err: err.message }, 'errore socket');
      });
    },
  );
}
