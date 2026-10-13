import { type BrainService, NOTE_TYPES } from '@ernie/brain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface BrainRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly brain: BrainService;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ListQuery = z.object({
  q: z.string().max(300).optional(),
  type: z.enum(NOTE_TYPES).optional(),
  place: z.string().max(80).optional(),
  from: day.optional(),
  to: day.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const NoteQuery = z.object({
  title: z.string().max(200).optional(),
  path: z.string().max(300).optional(),
});

/** Second brain nell'app (sola lettura in questa fase): elenco e ricerca, lettura di una nota con i rimandi. */
export async function brainRoutes(app: FastifyInstance, opts: BrainRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/brain/notes', async (req, reply) => {
      const { userId } = requireAuth(req);
      const q = ListQuery.safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: 'invalid_query', message: 'parametri non validi' });
      const { q: text, limit, ...filters } = q.data;
      // Nell'app l'utente vede anche le proprie note riservate.
      const query = { ...filters, includePrivate: true, limit: limit ?? 60 };
      const notes = text?.trim()
        ? (await opts.brain.search(userId, { ...query, query: text })).map(
            ({ passage, heading: _h, score: _s, ...n }) => ({ ...n, excerpt: passage }),
          )
        : await opts.brain.list(userId, query);
      return { notes };
    });

    api.get('/v1/brain/note', async (req, reply) => {
      const { userId } = requireAuth(req);
      const q = NoteQuery.safeParse(req.query);
      const ref = q.success ? (q.data.path ?? q.data.title) : undefined;
      if (!ref)
        return reply.code(400).send({ error: 'invalid_query', message: 'atteso title o path' });
      const r = await opts.brain.read(userId, ref);
      if (!r) return reply.code(404).send({ error: 'not_found', message: 'Nota non trovata' });
      const n = r.note;
      return {
        note: {
          path: n.path,
          title: n.title,
          type: n.type,
          created: n.created,
          refersFrom: n.refersFrom ?? null,
          refersTo: n.refersTo ?? null,
          place: n.place ?? null,
          coords: n.coords ?? null,
          links: n.links,
          private: n.private,
          source: n.source ?? null,
          body: n.body,
        },
        backlinks: r.backlinks,
      };
    });
  });
}
