import { ReminderDetailsPatch, reminderDetailsOf } from '@ernie/protocol';
import { type Reminder, type ReminderStore, repeatLabel } from '@ernie/skills';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthContext, Authenticator } from '../auth.js';
import { createAuthHook } from '../ws/plugin.js';

export interface RemindersRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly store: ReminderStore;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

const json = (r: Reminder) => ({
  id: r.id,
  text: r.text,
  ...reminderDetailsOf(r),
  ...(r.locationAddress ? { locationAddress: r.locationAddress } : {}),
  ...(r.at ? { at: r.at.toISOString() } : {}),
  status: r.status,
  ...(r.place ? { place: r.place } : {}),
  ...(r.for ? { for: r.for } : {}),
  ...(r.from ? { from: r.from } : {}),
  ...(r.channels ? { channels: r.channels } : {}),
  ...(r.repeat ? { repeat: { ...r.repeat, label: repeatLabel(r.repeat) } } : {}),
  ...(r.eventAt ? { eventAt: r.eventAt.toISOString() } : {}),
});

/** Promemoria per l'app (scheda e widget): elenco dei prossimi, modifica e annullamento. */
export async function remindersRoutes(
  app: FastifyInstance,
  opts: RemindersRoutesOptions,
): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/reminders', async (req) => {
      const auth = requireAuth(req);
      const list = await opts.store.list(auth.userId);
      return {
        reminders: list.map(json),
      };
    });

    api.patch('/v1/reminders/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const b = z
        .object({
          ...ReminderDetailsPatch.shape,
          text: z.string().min(1).max(300).optional(),
          at: z.iso.datetime().optional(),
          /** v1.11: canali del promemoria (email, sveglia); si cambiano senza cambiare l'id. */
          channels: z
            .object({ email: z.boolean().optional(), alarm: z.boolean().optional() })
            .strict()
            .optional(),
        })
        .strict()
        .refine((x) => Object.values(x).some((v) => v !== undefined), {
          message: 'atteso almeno un campo da aggiornare',
        })
        .safeParse(req.body);
      if (!b.success)
        return reply
          .code(400)
          .send({
            error: 'invalid_body',
            message: 'Dati non validi: verifica testo, orario, luogo, link e note',
          });
      const r = await opts.store.update(auth.userId, id, {
        ...ReminderDetailsPatch.parse(b.data),
        ...(b.data.text !== undefined ? { text: b.data.text } : {}),
        ...(b.data.at !== undefined ? { at: new Date(b.data.at) } : {}),
        ...(b.data.channels !== undefined
          ? {
              channels: {
                ...(b.data.channels.email !== undefined ? { email: b.data.channels.email } : {}),
                ...(b.data.channels.alarm !== undefined ? { alarm: b.data.channels.alarm } : {}),
              },
            }
          : {}),
      });
      if (!r)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'promemoria inesistente o ora già passata' });
      // Email accesa ma indirizzo assente nella scheda: l'app lo chiede subito.
      const needsEmail =
        b.data.channels?.email === true &&
        opts.store.emailAddress !== undefined &&
        !(await opts.store.emailAddress(auth.userId));
      return { reminder: json(r), ...(needsEmail ? { needsEmail: true } : {}) };
    });

    api.delete('/v1/reminders/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const id = (req.params as { id: string }).id;
      if (!z.uuid().safeParse(id).success)
        return reply.code(400).send({ error: 'invalid_id', message: 'id non valido' });
      const ok = await opts.store.remove(auth.userId, id);
      if (!ok)
        return reply.code(404).send({ error: 'not_found', message: 'promemoria inesistente' });
      return reply.code(204).send();
    });
  });
}
