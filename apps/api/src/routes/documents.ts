import type { DocumentRepository } from '@ernie/documents';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface DocumentsRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly repo: DocumentRepository;
  /** Dopo il caricamento: indicizzazione a pezzi con pagina (ricerca 11, S2), in background. */
  readonly onCreated?: (
    userId: string,
    documentId: string,
    pageTexts: readonly string[],
    title: string,
  ) => void;
}

/** Il telefono invia solo il testo estratto (OCR integrato): niente file, niente originali sul server. */
const CreateBody = z
  .object({
    title: z.string().max(160).optional(),
    source: z.enum(['scan', 'photo', 'pdf']),
    language: z.string().max(16).optional(),
    pages: z.array(z.string().max(60_000)).min(1).max(300),
  })
  .refine((b) => b.pages.some((p) => p.trim().length > 0), {
    message: 'nessun testo riconosciuto nelle pagine',
  })
  .refine((b) => b.pages.reduce((n, p) => n + p.length, 0) <= 400_000, {
    message: 'documento troppo lungo (massimo 400.000 caratteri)',
  });

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

export async function documentsRoutes(
  app: FastifyInstance,
  opts: DocumentsRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.post('/v1/documents', { bodyLimit: 2_000_000 }, async (req, reply) => {
      const auth = requireAuth(req);
      const b = CreateBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({
          error: 'invalid_body',
          message: b.error.issues[0]?.message ?? 'corpo non valido',
        });
      const meta = await opts.repo.create(auth.userId, {
        source: b.data.source,
        pageTexts: b.data.pages,
        ...(b.data.title ? { title: b.data.title } : {}),
        ...(b.data.language ? { language: b.data.language } : {}),
      });
      opts.onCreated?.(auth.userId, meta.id, b.data.pages, meta.title);
      return reply.code(201).send({
        id: meta.id,
        title: meta.title,
        pages: meta.pages,
        chars: meta.chars,
        source: meta.source,
      });
    });

    api.get('/v1/documents', async (req) => {
      const auth = requireAuth(req);
      const q = (req.query as { q?: string; limit?: string }) ?? {};
      const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
      return { documents: await opts.repo.list(auth.userId, q.q, limit) };
    });

    api.get('/v1/documents/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const doc = await opts.repo.get(auth.userId, id);
      if (!doc)
        return reply.code(404).send({ error: 'not_found', message: 'documento inesistente' });
      const { pageTexts: _pages, ...rest } = doc;
      return rest;
    });

    api.delete('/v1/documents/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const ok = await opts.repo.remove(auth.userId, id);
      if (!ok)
        return reply.code(404).send({ error: 'not_found', message: 'documento inesistente' });
      return reply.code(204).send();
    });
  });
}
