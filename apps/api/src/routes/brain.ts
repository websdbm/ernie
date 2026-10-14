import { type BrainService, NOTE_TYPES, type ReadResult } from '@ernie/brain';
import { type Pool, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import {
  authorizedSenders,
  emailToNote,
  newInboxToken,
  normalizeEmails,
  parseInboundPayload,
} from '../brain-inbound.js';
import { createAuthHook } from '../ws/plugin.js';

export interface BrainRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly brain: BrainService;
  /** Per l'indirizzo di inoltro (token nelle impostazioni) e il controllo del mittente. */
  readonly pool?: Pool;
  /** Pagina web → titolo e testo (Firecrawl), per i link condivisi da altre app. */
  readonly fetchPage?: (url: string) => Promise<{ title: string; content: string } | null>;
  /** Inoltro email: segreto del webhook di Brevo e dominio di ricezione (`<token>@dominio`). */
  readonly inbound?: { readonly secret: string; readonly domain: string };
  /** True se la chiave è nuova (Redis NX): evita note doppie quando Brevo ritenta il webhook. */
  readonly firstSeen?: (key: string, ttlSeconds: number) => Promise<boolean>;
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
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
/** Tipi che l'utente può scegliere dall'app (le pagine generate, «Chi sono» e Salute, no). */
const USER_TYPES = ['nota', 'persona', 'luogo', 'progetto', 'argomento'] as const;
const CreateBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    body: z.string().min(1).max(60_000),
    type: z.enum(USER_TYPES).optional(),
    private: z.boolean().optional(),
  })
  .strict();
const UpdateBody = z
  .object({
    path: z.string().min(1).max(300),
    body: z.string().max(60_000).optional(),
    private: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.body !== undefined || b.private !== undefined, {
    message: 'niente da cambiare',
  });
const PathQuery = z.object({ path: z.string().min(1).max(300) });
const ShareBody = z
  .object({
    url: z.url().max(2000).optional(),
    text: z.string().max(60_000).optional(),
    title: z.string().trim().max(120).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.url) || Boolean(b.text?.trim()), { message: 'serve url o text' });

/** Pagine generate da Ernie: dall'app non si modificano né si cancellano. */
const GENERATED = new Set(['chi-sono', 'salute']);

const noteJson = (r: ReadResult) => {
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
};

/** Titolo di un link condiviso: quello dato, poi quello della pagina, poi il sito. */
export function shareTitle(
  input: { url?: string | undefined; text?: string | undefined; title?: string | undefined },
  pageTitle?: string,
): string {
  const given = input.title?.trim();
  if (given) return given.slice(0, 120);
  const fromPage = pageTitle?.replace(/\s+/g, ' ').trim();
  if (fromPage) return fromPage.slice(0, 120);
  if (input.url) {
    try {
      return new URL(input.url).hostname.replace(/^www\./, '');
    } catch {
      /* titolo dal testo */
    }
  }
  const firstLine =
    (input.text ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine) || 'Appunto condiviso';
}

/**
 * Second brain nell'app: elenco e ricerca, lettura con i rimandi; dalla fase B3 anche scrittura, modifica e
 * cancellazione delle note, note condivise da altre app, indirizzo per l'inoltro email e webhook di ricezione.
 */
export async function brainRoutes(app: FastifyInstance, opts: BrainRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);

  // Webhook di Brevo (inoltro email): nessun utente autenticato, protetto dal segreto nell'URL.
  app.post('/v1/brain/inbound/email', async (req, reply) => {
    const inbound = opts.inbound;
    const pool = opts.pool;
    if (!inbound || !pool)
      return reply.code(404).send({ error: 'not_configured', message: 'inoltro email non attivo' });
    if ((req.query as { key?: string } | undefined)?.key !== inbound.secret)
      return reply.code(401).send({ error: 'unauthorized', message: 'chiave non valida' });
    const messages = parseInboundPayload(req.body, inbound.domain);
    let saved = 0;
    for (const m of messages) {
      const userId =
        (await pool.query<{ id: string | null }>(`SELECT brain_inbox_user($1) AS id`, [m.token]))
          .rows[0]?.id ?? null;
      if (!userId) {
        opts.logger?.warn({ token: m.token }, 'inoltro email: token sconosciuto');
        continue;
      }
      const senders = await withUser(pool, userId, async (c) =>
        authorizedSenders(
          (
            await c.query<{ email: string | null; extra: unknown }>(
              `SELECT settings->>'email' AS email, settings->'extraEmails' AS extra FROM users WHERE id = $1`,
              [userId],
            )
          ).rows[0] ?? {},
        ),
      );
      if (!senders.has(m.from)) {
        opts.logger?.warn({ userId, from: m.from }, 'inoltro email: mittente non riconosciuto');
        continue;
      }
      if (opts.firstSeen && !(await opts.firstSeen(`brain:inbound:${m.messageId}`, 7 * 86_400)))
        continue;
      const { title, body } = emailToNote(m);
      await opts.brain.write(userId, {
        title,
        body,
        type: 'nota',
        source: 'email',
        ...(m.sentOn ? { refersFrom: m.sentOn } : {}),
      });
      saved++;
    }
    return { received: messages.length, saved };
  });

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
      if (!r) {
        // Pagina citata con [[…]] ma non ancora scritta: si mostra chi la cita, così il grafo resta navigabile.
        const title = ref.replace(/\.md$/i, '').split('/').pop() ?? ref;
        const citing = await opts.brain.list(userId, {
          linkedTo: title,
          includePrivate: true,
          limit: 50,
        });
        if (!citing.length)
          return reply.code(404).send({ error: 'not_found', message: 'Nota non trovata' });
        return {
          note: {
            path: '',
            title,
            type: 'argomento',
            created: citing[0]?.created ?? new Date().toISOString(),
            refersFrom: null,
            refersTo: null,
            place: null,
            coords: null,
            links: [],
            private: false,
            source: null,
            body: 'Pagina non ancora scritta: la citano le note qui sotto. Chiedi a Ernie di scriverla.',
          },
          backlinks: citing.map((n) => n.title),
        };
      }
      return noteJson(r);
    });

    // B3: nuova nota scritta a mano nell'app.
    api.post('/v1/brain/notes', async (req, reply) => {
      const { userId } = requireAuth(req);
      const b = CreateBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'attesi title e body' });
      const w = await opts.brain.write(userId, {
        title: b.data.title,
        body: b.data.body,
        type: b.data.type ?? 'nota',
        mode: 'create',
        source: 'app',
        ...(b.data.private !== undefined ? { private: b.data.private } : {}),
      });
      const r = await opts.brain.read(userId, w.path);
      if (!r) return reply.code(500).send({ error: 'not_found', message: 'nota non rileggibile' });
      return reply.code(201).send(noteJson(r));
    });

    // B3: modifica dall'app (testo, riservatezza). Le pagine generate restano di Ernie.
    api.patch('/v1/brain/note', async (req, reply) => {
      const { userId } = requireAuth(req);
      const b = UpdateBody.safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'attesi path e body e/o private' });
      const current = await opts.brain.read(userId, b.data.path);
      if (!current)
        return reply.code(404).send({ error: 'not_found', message: 'Nota non trovata' });
      if (GENERATED.has(current.note.type))
        return reply
          .code(403)
          .send({ error: 'generated', message: 'Pagina generata da Ernie: si aggiorna da sola' });
      const r = await opts.brain.update(userId, b.data.path, {
        ...(b.data.body !== undefined ? { body: b.data.body } : {}),
        ...(b.data.private !== undefined ? { private: b.data.private } : {}),
        source: 'app',
      });
      if (!r) return reply.code(404).send({ error: 'not_found', message: 'Nota non trovata' });
      return noteJson(r);
    });

    api.delete('/v1/brain/note', async (req, reply) => {
      const { userId } = requireAuth(req);
      const q = PathQuery.safeParse(req.query);
      if (!q.success)
        return reply.code(400).send({ error: 'invalid_query', message: 'atteso path' });
      const current = await opts.brain.read(userId, q.data.path);
      if (!current)
        return reply.code(404).send({ error: 'not_found', message: 'Nota non trovata' });
      if (GENERATED.has(current.note.type))
        return reply
          .code(403)
          .send({ error: 'generated', message: 'Pagina generata da Ernie: non si cancella' });
      await opts.brain.remove(userId, q.data.path);
      return reply.code(204).send();
    });

    // B3: condivisione da altre app (link o testo), con una nota facoltativa.
    api.post('/v1/brain/share', async (req, reply) => {
      const { userId } = requireAuth(req);
      const b = ShareBody.safeParse(req.body);
      if (!b.success)
        return reply.code(400).send({ error: 'invalid_body', message: 'attesi url o text' });
      const { url, text, note } = b.data;
      let page: { title: string; content: string } | null = null;
      if (url && opts.fetchPage) {
        try {
          page = await opts.fetchPage(url);
        } catch (err) {
          opts.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), url },
            'pagina condivisa non letta',
          );
        }
      }
      const title = shareTitle(b.data, page?.title);
      const parts = [
        ...(note ? [note] : []),
        ...(url ? [`Fonte: ${url}`] : []),
        ...(page?.content ? [page.content.slice(0, 6_000)] : []),
        ...(text?.trim() ? [text.trim()] : []),
      ];
      const w = await opts.brain.write(userId, {
        title,
        body: parts.join('\n\n'),
        type: 'nota',
        mode: 'create',
        source: 'condiviso',
      });
      return reply.code(201).send({ title: w.title, path: w.path, created: w.created });
    });

    // B3: indirizzo personale per l'inoltro email (creato alla prima richiesta); null se non configurato.
    api.get('/v1/brain/inbox-address', async (req) => {
      const { userId } = requireAuth(req);
      const inbound = opts.inbound;
      const pool = opts.pool;
      if (!inbound || !pool) return { address: null, email: null, extraEmails: [] };
      let email: string | null = null;
      let extraEmails: string[] = [];
      const token = await withUser(pool, userId, async (c) => {
        const row = (
          await c.query<{ token: string | null; email: string | null; extra: unknown }>(
            `SELECT settings->>'brainInboxToken' AS token, settings->>'email' AS email,
                    settings->'extraEmails' AS extra FROM users WHERE id = $1`,
            [userId],
          )
        ).rows[0];
        email = row?.email?.trim() || null;
        extraEmails = normalizeEmails(row?.extra);
        if (row?.token) return row.token;
        const fresh = newInboxToken();
        await c.query(
          `UPDATE users SET settings = settings || jsonb_build_object('brainInboxToken', $2::text)
            WHERE id = $1 AND settings->>'brainInboxToken' IS NULL`,
          [userId, fresh],
        );
        return (
          (
            await c.query<{ token: string | null }>(
              `SELECT settings->>'brainInboxToken' AS token FROM users WHERE id = $1`,
              [userId],
            )
          ).rows[0]?.token ?? fresh
        );
      });
      // Mittenti accettati: l'email della scheda più gli altri indirizzi (PATCH /v1/me/settings { extraEmails }).
      return { address: `${token}@${inbound.domain}`, email, extraEmails };
    });
  });
}
