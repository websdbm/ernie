import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import {
  type FamilyRepository,
  OwnInviteError,
  RELATIONS,
  SupervisedUnlinkError,
} from '../family.js';
import { createAuthHook } from '../ws/plugin.js';

export interface FamilyRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly repo: FamilyRepository;
  /** Dopo un collegamento o scollegamento: gli agenti di sessione dei due utenti vanno ricostruiti. */
  readonly onChanged?: (userId: string) => void;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const Label = z.string().trim().min(1).max(40);
const InviteBody = z
  .object({
    label: Label,
    relation: z.enum(RELATIONS),
    myLabel: Label,
    supervised: z.boolean().optional(),
  })
  .strict();
const AcceptBody = z
  .object({ code: z.string().trim().min(4).max(12), label: Label.optional() })
  .strict();

/** Famiglia (M7e): collegamenti con etichetta, inviti con codice, accettazione, scollegamento. */
export async function familyRoutes(app: FastifyInstance, opts: FamilyRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/family', async (req) => {
      const auth = requireAuth(req);
      const [links, invites] = await Promise.all([
        opts.repo.list(auth.userId),
        opts.repo.listInvites(auth.userId),
      ]);
      return {
        links: links.map((l) => ({
          id: l.id,
          otherUserId: l.otherUserId,
          label: l.label,
          relation: l.relation,
          createdAt: l.createdAt.toISOString(),
        })),
        invites: invites.map((i) => ({
          code: i.code,
          label: i.label,
          relation: i.relation,
          myLabel: i.myLabel,
          expiresAt: i.expiresAt.toISOString(),
          supervised: i.supervised,
        })),
      };
    });

    // Prima di accettare: chi invita, come, e se l'invito porta il controllo genitori (consenso informato).
    api.get('/v1/family/invites/:code/preview', async (req, reply) => {
      const auth = requireAuth(req);
      const p = await opts.repo.preview(auth.userId, (req.params as { code: string }).code);
      if (!p)
        return reply
          .code(404)
          .send({ error: 'invalid_code', message: 'codice non valido, già usato o scaduto' });
      return { invite: p };
    });

    api.post('/v1/family/invites', async (req, reply) => {
      const auth = requireAuth(req);
      const b = InviteBody.safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'attesi label, relation e myLabel' });
      const i = await opts.repo.createInvite(auth.userId, b.data);
      return reply.code(201).send({
        invite: {
          code: i.code,
          label: i.label,
          relation: i.relation,
          myLabel: i.myLabel,
          expiresAt: i.expiresAt.toISOString(),
          supervised: i.supervised,
        },
      });
    });

    api.delete('/v1/family/invites/:code', async (req, reply) => {
      const auth = requireAuth(req);
      const ok = await opts.repo.removeInvite(auth.userId, (req.params as { code: string }).code);
      if (!ok) return reply.code(404).send({ error: 'not_found', message: 'invito inesistente' });
      return reply.code(204).send();
    });

    api.post('/v1/family/accept', async (req, reply) => {
      const auth = requireAuth(req);
      const b = AcceptBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'atteso un codice' });
      try {
        const link = await opts.repo.accept(auth.userId, b.data.code, b.data.label);
        if (!link)
          return reply
            .code(404)
            .send({ error: 'invalid_code', message: 'codice non valido, già usato o scaduto' });
        opts.onChanged?.(auth.userId);
        opts.onChanged?.(link.otherUserId);
        return reply.code(201).send({
          link: {
            id: link.id,
            otherUserId: link.otherUserId,
            label: link.label,
            relation: link.relation,
            createdAt: link.createdAt.toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof OwnInviteError)
          return reply.code(400).send({ error: 'own_invite', message: err.message });
        throw err;
      }
    });

    api.delete('/v1/family/links/:otherUserId', async (req, reply) => {
      const auth = requireAuth(req);
      const other = (req.params as { otherUserId: string }).otherUserId;
      if (!z.uuid().safeParse(other).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      let ok: boolean;
      try {
        ok = await opts.repo.unlink(auth.userId, other);
      } catch (err) {
        if (err instanceof SupervisedUnlinkError)
          return reply.code(403).send({ error: 'supervised', message: err.message });
        throw err;
      }
      if (!ok)
        return reply.code(404).send({ error: 'not_found', message: 'collegamento inesistente' });
      opts.onChanged?.(auth.userId);
      opts.onChanged?.(other);
      return reply.code(204).send();
    });
  });
}
