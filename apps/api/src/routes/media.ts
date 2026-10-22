import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import type { MediaLabels, MediaRepository } from '../media.js';
import { mediaThumbnail } from '../media-image.js';
import { createAuthHook } from '../ws/plugin.js';

export interface MediaRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  repo: MediaRepository;
  labeler?: (input: {
    userId: string;
    id: string;
    image: Buffer;
    ocrText: string;
  }) => Promise<MediaLabels>;
  thumbnail?: typeof mediaThumbnail;
}
function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw Object.assign(new Error('Non autenticato'), { statusCode: 401 });
  return req.auth;
}
const Id = z.object({ id: z.uuid() });
const Query = z
  .object({
    q: z.string().trim().max(120).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    tag: z.string().trim().min(1).max(30).optional(),
    year: z.coerce.number().int().min(1970).max(2200).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(60).default(30),
  })
  .strict();
const Upload = z
  .object({
    clientId: z.uuid(),
    data: z.string().min(16).max(4_000_000),
    source: z.enum(['photo', 'scan', 'library']),
    title: z.string().trim().min(1).max(160).optional(),
    ocrText: z.string().max(60_000).default(''),
    autoOrganize: z.boolean().default(true),
    location: z
      .object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        capturedAt: z.iso.datetime({ offset: true }).optional(),
        accuracy: z.number().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const Labels = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000),
    category: z.string().trim().min(1).max(40),
    tags: z.array(z.string().trim().min(1).max(30)).max(10),
    version: z.number().int().min(1),
  })
  .strict();

export async function mediaRoutes(app: FastifyInstance, opts: MediaRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
      if (!req.auth?.scopes.includes('chat'))
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Accesso alla raccolta non consentito.' });
    });
    api.get('/v1/media', async (req, reply) => {
      const q = Query.safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: 'invalid_query', message: 'Filtri non validi.' });
      return opts.repo.browse(requireAuth(req).userId, q.data);
    });
    api.post('/v1/media', { bodyLimit: 4_100_000 }, async (req, reply) => {
      const parsed = Upload.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'Foto o dati non validi.' });
      const body = parsed.data;
      const image = Buffer.from(body.data, 'base64');
      if (!image.length || image.length > 3_000_000 || image.toString('base64') !== body.data)
        return reply
          .code(400)
          .send({ error: 'invalid_image', message: 'Formato della foto non valido.' });
      const prepared = await (opts.thumbnail ?? mediaThumbnail)(image);
      const userId = requireAuth(req).userId;
      const title =
        body.title ??
        `Foto del ${new Intl.DateTimeFormat('it-IT', { dateStyle: 'long', timeZone: 'Europe/Rome' }).format(new Date())}`;
      const saved = await opts.repo.create(userId, {
        ...prepared,
        image,
        clientId: body.clientId,
        source: body.source,
        title,
        ocrText: body.ocrText,
        autoOrganize: body.autoOrganize,
        ...(body.location ? { location: body.location } : {}),
      });
      let item = saved.item;
      if (saved.created && body.autoOrganize) {
        try {
          if (!opts.labeler || requireAuth(req).settings.killSwitch === true)
            throw new Error('Catalogazione non disponibile');
          const labels = await opts.labeler({
            userId,
            id: item.id,
            image: prepared.thumbnail,
            ocrText: body.ocrText,
          });
          // Una modifica manuale intervenuta durante la generazione ha la precedenza.
          item =
            (await opts.repo.update(
              userId,
              item.id,
              { ...labels, ...(body.title ? { title: body.title } : {}) },
              item.version,
              true,
            )) ?? item;
        } catch {
          await opts.repo.markFailed(userId, item.id);
          item = (await opts.repo.get(userId, item.id)) ?? item;
        }
      }
      return reply.code(saved.created ? 201 : 200).send({ item, created: saved.created });
    });
    api.get('/v1/media/:id', async (req, reply) => {
      const p = Id.safeParse(req.params);
      if (!p.success)
        return reply.code(400).send({ error: 'invalid_id', message: 'Immagine non valida.' });
      const item = await opts.repo.get(requireAuth(req).userId, p.data.id);
      return item
        ? { item }
        : reply.code(404).send({ error: 'not_found', message: 'Immagine non trovata.' });
    });
    api.get('/v1/media/:id/image', async (req, reply) => {
      const p = Id.safeParse(req.params),
        q = z
          .object({ size: z.enum(['thumbnail', 'full']).default('full') })
          .strict()
          .safeParse(req.query);
      if (!p.success || !q.success)
        return reply.code(400).send({ error: 'invalid_query', message: 'Immagine non valida.' });
      const image = await opts.repo.image(
        requireAuth(req).userId,
        p.data.id,
        q.data.size === 'thumbnail',
      );
      if (!image)
        return reply.code(404).send({ error: 'not_found', message: 'Immagine non trovata.' });
      return reply.header('content-type', 'image/jpeg').send(image);
    });
    api.patch('/v1/media/:id', async (req, reply) => {
      const p = Id.safeParse(req.params),
        b = Labels.safeParse(req.body);
      if (!p.success || !b.success)
        return reply.code(400).send({
          error: 'invalid_body',
          message: 'Inserisci titolo, categoria e al massimo 10 tag di 30 caratteri.',
        });
      const item = await opts.repo.update(
        requireAuth(req).userId,
        p.data.id,
        b.data,
        b.data.version,
      );
      return item
        ? { item }
        : reply.code(404).send({ error: 'not_found', message: 'Immagine non trovata.' });
    });
    api.delete('/v1/media/:id', async (req, reply) => {
      const p = Id.safeParse(req.params);
      if (!p.success)
        return reply.code(400).send({ error: 'invalid_id', message: 'Immagine non valida.' });
      if (!(await opts.repo.remove(requireAuth(req).userId, p.data.id)))
        return reply.code(404).send({ error: 'not_found', message: 'Immagine non trovata.' });
      return reply.code(204).send();
    });
  });
}
