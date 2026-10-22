import { SshProvider } from '@ernie/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';
import type { SshService } from './service.js';
import { SshError } from './types.js';

export interface SshRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly service: SshService;
}
const bodyObject = z.record(z.string(), z.unknown());
const user = (req: FastifyRequest) => {
  if (!req.auth) throw new SshError('unauthorized', 'Non autenticato.', 401);
  return req.auth.userId;
};
const id = (req: FastifyRequest) => {
  const parsed = z.object({ id: z.uuid() }).safeParse(req.params);
  if (!parsed.success) throw new SshError('invalid_id', 'Identificativo non valido.');
  return parsed.data.id;
};
const provider = (req: FastifyRequest) => {
  const parsed = z.object({ provider: SshProvider }).safeParse(req.params);
  if (!parsed.success) throw new SshError('invalid_provider', 'Provider non riconosciuto.');
  return parsed.data.provider;
};
const empty = (body: unknown) => {
  if (
    !z
      .object({})
      .strict()
      .safeParse(body ?? {}).success
  )
    throw new SshError(
      'invalid_input',
      'Questa richiesta non accetta comandi o parametri aggiuntivi.',
    );
};
export async function sshRoutes(app: FastifyInstance, opts: SshRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!req.auth)
        return reply.code(401).send({ error: 'unauthorized', message: 'Non autenticato.' });
      if (!req.auth.scopes.includes('chat'))
        return reply
          .code(403)
          .send({ error: 'scope_required', message: 'Permesso chat richiesto.' });
    });
    api.setErrorHandler((error, _req, reply) => {
      if (error instanceof SshError)
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return reply.code(500).send({
        error: 'ssh_failed',
        message: 'Operazione SSH non completata. Nessun dettaglio sensibile è stato esposto.',
      });
    });
    api.get('/v1/ssh', async (req) => opts.service.snapshot(user(req)));
    api.post('/v1/ssh/key', async (req) => {
      const parsed = z.object({ rotate: z.boolean() }).strict().safeParse(req.body);
      if (!parsed.success) throw new SshError('invalid_input', 'Indica se vuoi ruotare la chiave.');
      return opts.service.keyGenerate(user(req), parsed.data.rotate);
    });
    api.delete('/v1/ssh/key', async (req) => opts.service.keyRevoke(user(req)));
    api.post('/v1/ssh/servers', async (req) =>
      opts.service.serverSave(user(req), req.body as never),
    );
    api.post('/v1/ssh/sites', async (req) => opts.service.siteSave(user(req), req.body as never));
    api.post('/v1/ssh/servers/:id/probe', async (req) => {
      empty(req.body);
      return opts.service.hostProbe(user(req), id(req));
    });
    api.post('/v1/ssh/servers/:id/trust', async (req) => {
      const parsed = z
        .object({ fingerprint: z.string().min(1).max(512) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) throw new SshError('invalid_input', 'Indica l’impronta da verificare.');
      return opts.service.hostTrust(user(req), id(req), parsed.data.fingerprint);
    });
    api.post('/v1/ssh/diagnose', async (req) =>
      opts.service.diagnose(user(req), req.body as never),
    );
    api.put('/v1/ssh/providers/:provider', async (req) => {
      const parsed = bodyObject.safeParse(req.body);
      if (!parsed.success) throw new SshError('invalid_input', 'Credenziali provider non valide.');
      const p = provider(req);
      return opts.service.providerSave(user(req), p, { provider: p, ...parsed.data });
    });
    api.delete('/v1/ssh/providers/:provider', async (req) =>
      opts.service.providerDisconnect(user(req), provider(req)),
    );
    api.get('/v1/ssh/providers/:provider/instances', async (req) =>
      opts.service.providerInstances(user(req), provider(req)),
    );
    api.post('/v1/ssh/import/preview', async (req) =>
      opts.service.importPreview(user(req), req.body as never),
    );
    api.post('/v1/ssh/import/apply', async (req) =>
      opts.service.importApply(user(req), req.body as never),
    );
    api.post('/v1/ssh/operations', async (req) => opts.service.plan(user(req), req.body as never));
    api.post('/v1/ssh/operations/:id/approve', async (req) => {
      empty(req.body);
      return opts.service.approve(user(req), id(req));
    });
    api.post('/v1/ssh/operations/:id/reject', async (req) => {
      empty(req.body);
      return opts.service.reject(user(req), id(req));
    });
    api.get('/v1/ssh/operations/:id', async (req) => opts.service.operation(user(req), id(req)));
  });
}
