import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import {
  type FamilyMessage,
  type FamilyMessageStore,
  type FamilyMessenger,
  NotLinkedError,
} from '../family-messages.js';
import { createAuthHook } from '../ws/plugin.js';

export interface FamilyMessagesRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly store: FamilyMessageStore;
  readonly messenger: FamilyMessenger;
  /** Skill «Messaggi» attiva per chi scrive (controllo genitori compreso); senza, sempre permesso. */
  readonly canSend?: (userId: string) => Promise<boolean>;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

/** Foto già ridotta sul telefono: al più circa 3 MB una volta decodificata. */
const MAX_IMAGE_BYTES = 3_000_000;

const SendBody = z
  .object({
    to: z.uuid(),
    text: z.string().max(2000).default(''),
    replyTo: z.uuid().optional(),
    image: z
      .object({
        mime: z.enum(['image/jpeg', 'image/png', 'image/heic']),
        data: z
          .string()
          .min(16)
          .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8),
        width: z.number().int().positive().max(10_000).optional(),
        height: z.number().int().positive().max(10_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => b.text.trim() !== '' || b.image, { message: 'serve un testo o una foto' });

const json = (m: FamilyMessage) => ({
  id: m.id,
  direction: m.direction,
  otherUserId: m.otherUserId,
  label: m.label,
  text: m.text,
  image: m.image,
  replyTo: m.replyTo,
  at: m.at.toISOString(),
  readAt: m.readAt?.toISOString() ?? null,
});

/** Messaggi in famiglia (0033): invio con foto, elenco, foto, lettura. */
export async function familyMessagesRoutes(
  app: FastifyInstance,
  opts: FamilyMessagesRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.post('/v1/family/messages', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
      const { userId } = requireAuth(req);
      const b = SendBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({
          error: 'invalid_body',
          message: b.error.issues[0]?.message ?? 'messaggio non valido',
        });
      if (opts.canSend && !(await opts.canSend(userId)))
        return reply
          .code(403)
          .send({ error: 'skill_disabled', message: 'la skill Messaggi non è attiva' });
      let image: { mime: string; bytes: Buffer; width?: number; height?: number } | undefined;
      if (b.data.image) {
        const bytes = Buffer.from(b.data.image.data, 'base64');
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
          return reply.code(413).send({ error: 'image_too_large', message: 'foto troppo grande' });
        image = {
          mime: b.data.image.mime,
          bytes,
          ...(b.data.image.width ? { width: b.data.image.width } : {}),
          ...(b.data.image.height ? { height: b.data.image.height } : {}),
        };
      }
      try {
        const m = await opts.messenger.send(userId, {
          to: b.data.to,
          text: b.data.text,
          ...(image ? { image } : {}),
          ...(b.data.replyTo ? { replyTo: b.data.replyTo } : {}),
        });
        return reply.code(201).send({ message: json(m) });
      } catch (err) {
        if (err instanceof NotLinkedError)
          return reply.code(403).send({ error: 'not_linked', message: err.message });
        throw err;
      }
    });

    api.get('/v1/family/messages', async (req) => {
      const { userId } = requireAuth(req);
      const q = req.query as { since?: string; limit?: string };
      const since = q.since && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since) : undefined;
      const limit = q.limit ? Number(q.limit) : undefined;
      const list = await opts.store.list(userId, {
        ...(since ? { since } : {}),
        ...(limit && Number.isFinite(limit) ? { limit } : {}),
      });
      return { messages: list.map(json) };
    });

    api.get('/v1/family/messages/:id/image', async (req, reply) => {
      const { userId } = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const img = await opts.store.image(userId, id);
      if (!img) return reply.code(404).send({ error: 'not_found', message: 'foto inesistente' });
      return reply
        .header('content-type', img.mime)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(img.bytes);
    });

    api.post('/v1/family/messages/read', async (req, reply) => {
      const { userId } = requireAuth(req);
      const b = z
        .object({ ids: z.array(z.uuid()).max(200) })
        .strict()
        .safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'atteso { ids: uuid[] }' });
      return { updated: await opts.store.markRead(userId, b.data.ids) };
    });
  });
}
