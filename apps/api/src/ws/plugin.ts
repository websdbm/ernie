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

  app.get(
    opts.path ?? '/v1/ws',
    { websocket: true, preValidation: createAuthHook(opts.authenticator, opts.allowedOrigins) },
    (socket, req) => {
      const auth = req.auth;
      if (!auth) {
        socket.close(1008, 'unauthorized');
        return;
      }
      const conn = new ClientConnection(socket, auth, opts.connection);
      socket.on('message', (data: Buffer | string) => {
        void conn.handleRaw(data);
      });
      socket.on('close', () => {
        void conn.close();
      });
      socket.on('error', (err: Error) => {
        opts.connection.logger.warn({ err: err.message }, 'errore socket');
      });
    },
  );
}
