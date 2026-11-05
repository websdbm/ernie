import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth.js';
import { resolveArchiveReference } from '../chat-archive/reference.js';
import { ArchiveAsk, type ChatArchiveAnalysis } from '../chat-archive/service.js';
import { ChatArchiveError, type ChatArchiveRepository } from '../chat-archive/types.js';
import { createAuthHook } from '../ws/plugin.js';
export interface ChatArchiveRoutesOptions {
  authenticator: Authenticator;
  allowedOrigins: readonly string[];
  repo: ChatArchiveRepository;
  analysis: ChatArchiveAnalysis;
  canUse(userId: string): Promise<boolean>;
}
const Id = z.object({ id: z.uuid() });
const Zone = z
  .string()
  .min(1)
  .max(80)
  .refine((s) => {
    try {
      new Intl.DateTimeFormat('it', { timeZone: s });
      return true;
    } catch {
      return false;
    }
  });
const ImportBody = z
  .object({
    filename: z.string().min(1).max(240),
    dataBase64: z.string().min(1).max(11_200_000),
    timeZone: Zone,
    archiveId: z.uuid().optional(),
    createNew: z.boolean().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(['direct', 'group']).optional(),
  })
  .strict()
  .refine((b) => !(b.archiveId && b.createNew), 'Scegli una chat esistente oppure una nuova.');
const ListQuery = z
  .object({
    q: z.string().trim().max(160).optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict();
const MessageQuery = ListQuery.extend({
  senderId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  aroundId: z.uuid().optional(),
}).refine(
  (b) => !b.from || !b.to || Date.parse(b.from) <= Date.parse(b.to),
  'Intervallo non valido.',
);
const Patch = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(['direct', 'group']).optional(),
    category: z.string().trim().min(1).max(60).nullable().optional(),
    summary: z.string().trim().max(600).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(),
    whatsappPhone: z.string().max(30).nullable().optional(),
    whatsappUrl: z.string().max(600).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nessuna modifica.');
function clean<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
function importInput(b: z.infer<typeof ImportBody>) {
  return {
    filename: b.filename,
    dataBase64: b.dataBase64,
    timeZone: b.timeZone,
    ...(b.archiveId ? { archiveId: b.archiveId } : {}),
    ...(b.createNew !== undefined ? { createNew: b.createNew } : {}),
    ...(b.name ? { name: b.name } : {}),
    ...(b.kind ? { kind: b.kind } : {}),
  };
}
function user(req: FastifyRequest): string {
  if (!req.auth) throw new ChatArchiveError(401, 'unauthorized', 'Accedi a Ernie.');
  return req.auth.userId;
}
const bad = () =>
  new ChatArchiveError(
    400,
    'invalid_input',
    'Dati non validi. Controlla file, intervallo e filtri.',
  );

export async function chatArchiveRoutes(app: FastifyInstance, opts: ChatArchiveRoutesOptions) {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.setErrorHandler((error, _req, reply) => {
      if (error instanceof ChatArchiveError)
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      // SQL/parse/provider errors can contain imported text. Never log or return their payloads.
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 413)
        return reply
          .code(413)
          .send({ error: 'file_too_large', message: 'File troppo grande: massimo 8 MB.' });
      if (status && status < 500)
        return reply
          .code(status)
          .send({ error: 'invalid_request', message: 'Richiesta dell’archivio non valida.' });
      return reply.code(503).send({
        error: 'archive_unavailable',
        message: 'Archivio chat temporaneamente non disponibile.',
      });
    });
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));
    api.addHook('preHandler', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!req.auth)
        return reply.code(401).send({ error: 'unauthorized', message: 'Accedi a Ernie.' });
      if (!req.auth.scopes.includes('chat') || !(await opts.canUse(req.auth.userId)))
        return reply.code(403).send({
          error: 'skill_disabled',
          message: 'Attiva la skill Archivio chat nelle impostazioni.',
        });
    });
    const windows = new Map<string, { at: number; count: number }>();
    const importFile =
      (preview: boolean) =>
      async (req: import('fastify').FastifyRequest, _reply: import('fastify').FastifyReply) => {
        const id = req.auth?.userId;
        if (!id) throw bad();
        for (const [key, value] of windows) if (Date.now() - value.at > 60000) windows.delete(key);
        const window = windows.get(id) ?? { at: Date.now(), count: 0 };
        if (window.count >= 20 || windows.size > 10000)
          throw new ChatArchiveError(
            429,
            'rate_limited',
            'Troppi import ravvicinati. Attendi un minuto.',
          );
        window.count++;
        windows.set(id, window);
        const body = ImportBody.safeParse(req.body);
        if (!body.success) throw bad();
        try {
          return preview
            ? await opts.repo.preview(id, importInput(body.data))
            : await opts.repo.import(id, importInput(body.data));
        } finally {
          req.body = undefined;
        }
      };
    api.post(
      '/v1/chat-archives/imports/preview',
      { bodyLimit: 12_000_000, logLevel: 'silent' },
      importFile(true),
    );
    api.post(
      '/v1/chat-archives/imports',
      { bodyLimit: 12_000_000, logLevel: 'silent' },
      importFile(false),
    );
    api.post(
      '/v1/chat-archives/resolve',
      { logLevel: 'silent', bodyLimit: 20_000 },
      async (req) => {
        const body = z
          .object({ request: z.string().trim().min(1).max(4000) })
          .strict()
          .safeParse(req.body);
        if (!body.success) throw bad();
        try {
          return await resolveArchiveReference(opts.repo, user(req), body.data.request);
        } finally {
          req.body = undefined;
        }
      },
    );
    api.get('/v1/chat-archives', { logLevel: 'silent' }, async (req) => {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) throw bad();
      return opts.repo.list(user(req), {
        offset: q.data.offset,
        limit: q.data.limit,
        ...(q.data.q ? { query: q.data.q } : {}),
      });
    });
    api.get('/v1/chat-archives/:id', { logLevel: 'silent' }, async (req) => {
      const id = Id.safeParse(req.params);
      if (!id.success) throw bad();
      const data = await opts.repo.get(user(req), id.data.id);
      if (!data) throw new ChatArchiveError(404, 'not_found', 'Chat non trovata.');
      return data;
    });
    api.get('/v1/chat-archives/:id/messages', { logLevel: 'silent' }, async (req) => {
      const id = Id.safeParse(req.params),
        q = MessageQuery.safeParse(req.query);
      if (!id.success || !q.success) throw bad();
      if (!(await opts.repo.get(user(req), id.data.id)))
        throw new ChatArchiveError(404, 'not_found', 'Chat non trovata.');
      const { q: query, ...filters } = q.data;
      return opts.repo.messages(user(req), id.data.id, {
        offset: filters.offset,
        limit: filters.limit,
        ...(filters.from ? { from: filters.from } : {}),
        ...(filters.to ? { to: filters.to } : {}),
        ...(filters.senderId ? { senderId: filters.senderId } : {}),
        ...(filters.aroundId ? { aroundId: filters.aroundId } : {}),
        ...(query ? { query } : {}),
      });
    });
    api.patch('/v1/chat-archives/:id', { logLevel: 'silent' }, async (req) => {
      const id = Id.safeParse(req.params),
        b = Patch.safeParse(req.body);
      if (!id.success || !b.success) throw bad();
      const archive = await opts.repo.update(user(req), id.data.id, clean(b.data));
      if (!archive) throw new ChatArchiveError(404, 'not_found', 'Chat non trovata.');
      return { archive };
    });
    api.delete('/v1/chat-archives/:id', { logLevel: 'silent' }, async (req, reply) => {
      const id = Id.safeParse(req.params);
      if (!id.success) throw bad();
      if (!(await opts.repo.remove(user(req), id.data.id)))
        throw new ChatArchiveError(404, 'not_found', 'Chat non trovata.');
      return reply.code(204).send();
    });
    api.post(
      '/v1/chat-archives/:id/ask',
      { logLevel: 'silent', bodyLimit: 100_000 },
      async (req, reply) => {
        const id = Id.safeParse(req.params),
          body = ArchiveAsk.safeParse(req.body);
        if (!id.success || !body.success) throw bad();
        const cancel = new AbortController();
        const closed = () => {
          if (!reply.raw.writableEnded) cancel.abort();
        };
        req.raw.on('aborted', closed);
        reply.raw.on('close', closed);
        try {
          return await opts.analysis.ask(
            user(req),
            id.data.id,
            body.data,
            AbortSignal.any([cancel.signal, AbortSignal.timeout(90_000)]),
          );
        } finally {
          req.body = undefined;
          req.raw.off('aborted', closed);
          reply.raw.off('close', closed);
        }
      },
    );
  });
}
