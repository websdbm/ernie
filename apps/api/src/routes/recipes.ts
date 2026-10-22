import { RECIPE_CATEGORIES, type RecipeRepository, RecipeVersionConflictError } from '@ernie/tools';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface RecipeRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly repo: RecipeRepository;
  /** Impostazioni effettive, incluso il controllo genitori, rilette per ogni richiesta. */
  readonly canUse: (userId: string) => Promise<boolean>;
}

function userId(req: FastifyRequest): string {
  if (!req.auth) throw Object.assign(new Error('Non autenticato'), { statusCode: 401 });
  return req.auth.userId;
}

const Query = z
  .object({
    q: z.string().trim().max(120).optional(),
    category: z.enum([...RECIPE_CATEGORIES, 'non-classificate']).optional(),
    tag: z.string().trim().min(1).max(30).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const Id = z.object({ id: z.uuid() });
const Organization = z
  .object({
    category: z.enum(RECIPE_CATEGORIES).nullable(),
    tags: z.array(z.string().trim().min(1).max(30)).max(10),
    version: z.number().int().min(1),
  })
  .strict();

/** Raccolta privata: leggere e organizzare non passa dal modello e non consuma token. */
export async function recipeRoutes(app: FastifyInstance, opts: RecipeRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!req.auth)
        return reply.code(401).send({ error: 'unauthorized', message: 'Non autenticato' });
      if (!req.auth.scopes.includes('chat') || !(await opts.canUse(req.auth.userId))) {
        return reply.code(403).send({
          error: 'skill_disabled',
          message: 'La funzione Ricette non è attiva per questo account.',
        });
      }
    });
    api.get('/v1/recipes', async (req, reply) => {
      const q = Query.safeParse(req.query);
      if (!q.success)
        return reply
          .code(400)
          .send({ error: 'invalid_query', message: 'Filtri di ricerca non validi.' });
      const { q: query, ...filters } = q.data;
      return opts.repo.browse(userId(req), { ...filters, ...(query ? { query } : {}) });
    });
    api.get('/v1/recipes/:id', async (req, reply) => {
      const id = Id.safeParse(req.params);
      if (!id.success)
        return reply.code(400).send({ error: 'invalid_id', message: 'Ricetta non valida.' });
      const recipe = await opts.repo.get(userId(req), id.data.id);
      if (!recipe)
        return reply.code(404).send({ error: 'not_found', message: 'Ricetta non trovata.' });
      return { recipe };
    });
    api.patch('/v1/recipes/:id', async (req, reply) => {
      const id = Id.safeParse(req.params),
        body = Organization.safeParse(req.body);
      if (!id.success || !body.success)
        return reply.code(400).send({
          error: 'invalid_body',
          message: 'Scegli una categoria e al massimo 10 tag, ciascuno di massimo 30 caratteri.',
        });
      try {
        const recipe = await opts.repo.organize(userId(req), id.data.id, body.data);
        if (!recipe)
          return reply.code(404).send({ error: 'not_found', message: 'Ricetta non trovata.' });
        return { recipe };
      } catch (error) {
        if (error instanceof RecipeVersionConflictError)
          return reply.code(409).send({
            error: 'version_conflict',
            message: 'La ricetta è cambiata nel frattempo. Riaprila prima di salvare le modifiche.',
          });
        throw error;
      }
    });
    api.delete('/v1/recipes/:id', async (req, reply) => {
      const id = Id.safeParse(req.params);
      if (!id.success)
        return reply.code(400).send({ error: 'invalid_id', message: 'Ricetta non valida.' });
      if (!(await opts.repo.remove(userId(req), id.data.id)))
        return reply.code(404).send({ error: 'not_found', message: 'Ricetta non trovata.' });
      return reply.code(204).send();
    });
  });
}
