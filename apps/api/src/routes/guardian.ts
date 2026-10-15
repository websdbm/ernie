import type { Pool } from '@ernie/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { SUPERVISABLE } from '../family.js';
import {
  DEFAULT_SKILLS,
  type GuardianStore,
  guardianCatalog,
  toTranscriptMessage,
} from '../guardian.js';
import { createAuthHook } from '../ws/plugin.js';

export interface GuardianRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly pool: Pool;
  readonly store: GuardianStore;
  /** Skill del figlio cambiate o controllo tolto: il suo agente va ricostruito. */
  readonly onChanged?: (userId: string) => void;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const SkillsBody = z.object({ allowed: z.array(z.string().min(1).max(40)).max(40) }).strict();

/**
 * Controllo genitori (0030). Genitore: figli seguiti, skill concesse, conversazioni (ogni lettura resta nel
 * registro che il figlio vede), revoca. Figlio: chi lo segue e l'ultima consultazione.
 */
export async function guardianRoutes(
  app: FastifyInstance,
  opts: GuardianRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    const childParam = (req: FastifyRequest) => {
      const id = (req.params as { childId: string }).childId;
      return z.uuid().safeParse(id).success ? id : null;
    };
    const guard = async (req: FastifyRequest) => {
      const auth = requireAuth(req);
      const childId = childParam(req);
      if (!childId || !(await opts.store.isGuardian(auth.userId, childId))) return null;
      return { guardianId: auth.userId, childId };
    };

    api.get('/v1/family/children', async (req) => {
      const auth = requireAuth(req);
      const children = await opts.store.children(auth.userId);
      return {
        children: children.map((c) => ({
          childId: c.childId,
          label: c.label,
          relation: c.relation,
          since: c.since.toISOString(),
          lastReviewAt: c.lastReviewAt?.toISOString() ?? null,
          skills: guardianCatalog(c.allowed),
        })),
      };
    });

    // Per l'invito con account seguito: le skill che si possono concedere e quelle proposte per parentela.
    api.get('/v1/family/skill-profiles', async (req) => {
      requireAuth(req);
      return {
        skills: guardianCatalog([]).map(({ allowed: _, ...s }) => s),
        defaults: Object.fromEntries(SUPERVISABLE.map((r) => [r, [...DEFAULT_SKILLS[r]]])),
      };
    });

    api.put('/v1/family/children/:childId/skills', async (req, reply) => {
      const g = await guard(req);
      if (!g)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'nessun figlio seguito con questo id' });
      const b = SkillsBody.safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: 'atteso { allowed: string[] }' });
      const allowed = await opts.store.setAllowed(g.guardianId, g.childId, b.data.allowed);
      if (!allowed)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'nessun figlio seguito con questo id' });
      opts.onChanged?.(g.childId);
      return { skills: guardianCatalog(allowed) };
    });

    api.delete('/v1/family/children/:childId', async (req, reply) => {
      const g = await guard(req);
      if (!g)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'nessun figlio seguito con questo id' });
      await opts.store.release(g.guardianId, g.childId);
      opts.onChanged?.(g.childId);
      return reply.code(204).send();
    });

    // Conversazioni del figlio, dalla più recente: titolo = prima domanda. La consultazione si registra.
    api.get('/v1/family/children/:childId/sessions', async (req, reply) => {
      const g = await guard(req);
      if (!g)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'nessun figlio seguito con questo id' });
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string })?.limit) || 40, 1),
        100,
      );
      const r = await opts.pool.query<{
        thread_id: string;
        started: Date;
        last: Date;
        user_msgs: string;
        first: string | null;
      }>(
        `SELECT thread_id,
                min(coalesce("createdAtZ", "createdAt")) AS started,
                max(coalesce("createdAtZ", "createdAt")) AS last,
                count(*) FILTER (WHERE role = 'user')::text AS user_msgs,
                (array_agg(content ORDER BY coalesce("createdAtZ", "createdAt")) FILTER (WHERE role = 'user'))[1] AS first
           FROM mastra_messages WHERE "resourceId" = $1
          GROUP BY thread_id ORDER BY last DESC LIMIT $2`,
        [g.childId, limit],
      );
      await opts.store.recordReview(g.guardianId, g.childId, null);
      return {
        sessions: r.rows.map((x) => {
          let title = '';
          try {
            title =
              toTranscriptMessage({ role: 'user', content: JSON.parse(x.first ?? '""') })?.text ??
              '';
          } catch {
            title = x.first ?? '';
          }
          return {
            id: x.thread_id,
            title: title.replace(/\s+/g, ' ').slice(0, 80) || 'Conversazione',
            startedAt: x.started.toISOString(),
            lastAt: x.last.toISOString(),
            userMessages: Number(x.user_msgs),
          };
        }),
      };
    });

    api.get('/v1/family/children/:childId/sessions/:sessionId', async (req, reply) => {
      const g = await guard(req);
      if (!g)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'nessun figlio seguito con questo id' });
      const sessionId = (req.params as { sessionId: string }).sessionId;
      if (!z.uuid().safeParse(sessionId).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const r = await opts.pool.query<{ role: string; content: string; at: Date }>(
        `SELECT role, content, coalesce("createdAtZ", "createdAt") AS at FROM mastra_messages
          WHERE "resourceId" = $1 AND thread_id = $2 ORDER BY at`,
        [g.childId, sessionId],
      );
      await opts.store.recordReview(g.guardianId, g.childId, sessionId);
      const messages = r.rows
        .map((x) => {
          let content: unknown = x.content;
          try {
            content = JSON.parse(x.content);
          } catch {
            /* testo semplice */
          }
          return toTranscriptMessage({ role: x.role, content, createdAt: x.at });
        })
        .filter((m) => m !== null);
      return { messages };
    });

    // Vista del figlio: avviso fisso nell'app e data dell'ultima consultazione.
    api.get('/v1/family/supervision', async (req) => {
      const auth = requireAuth(req);
      const s = await opts.store.supervision(auth.userId);
      return {
        supervised: s !== null,
        guardians: (s?.guardians ?? []).map((x) => ({
          label: x.label,
          since: x.since.toISOString(),
          lastReviewAt: x.lastReviewAt?.toISOString() ?? null,
        })),
        allowed: s?.allowed ?? null,
      };
    });
  });
}
