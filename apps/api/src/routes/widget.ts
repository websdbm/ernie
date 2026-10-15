import type { AutomationRepository } from '@ernie/automations';
import type { ReminderStore } from '@ernie/skills';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContext, Authenticator } from '../auth.js';
import type { FamilyMessageStore } from '../family-messages.js';
import { buildWidgetSummary } from '../widget.js';
import { createAuthHook } from '../ws/plugin.js';

export interface WidgetRoutesOptions {
  readonly authenticator: Authenticator;
  readonly allowedOrigins: readonly string[];
  readonly reminders: ReminderStore;
  readonly automations: AutomationRepository;
  /** Impostazioni effettive dell'utente (interruttore di emergenza, proattività). */
  readonly loadSettings: (userId: string) => Promise<Readonly<Record<string, unknown>>>;
  /** Messaggi in famiglia: l'ultimo va nel widget del blocco. */
  readonly familyMessages?: Pick<FamilyMessageStore, 'list'>;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const a = req.auth;
  if (!a)
    throw Object.assign(new Error('non autenticato'), { statusCode: 401, code: 'unauthorized' });
  return a;
}

/** Riepilogo per il widget grande (impegni, automazioni, attività, stato) in una sola richiesta. */
export async function widgetRoutes(app: FastifyInstance, opts: WidgetRoutesOptions): Promise<void> {
  if (!app.hasRequestDecorator('auth')) app.decorateRequest('auth', null);
  await app.register(async (api) => {
    api.addHook('preValidation', createAuthHook(opts.authenticator, opts.allowedOrigins));

    api.get('/v1/widget', async (req) => {
      const { userId } = requireAuth(req);
      const [settings, reminders, automations, runs, unread, family] = await Promise.all([
        opts.loadSettings(userId),
        opts.reminders.list(userId),
        opts.automations.list(userId),
        opts.automations.listRecentRuns(userId, 10),
        opts.automations.listNotifications(userId, true, 50),
        opts.familyMessages?.list(userId, { limit: 1 }).catch(() => []) ?? Promise.resolve([]),
      ]);
      return buildWidgetSummary({
        now: new Date(),
        settings,
        reminders,
        automations,
        runs,
        unread: unread.length,
        family: family.at(-1) ?? null,
      });
    });
  });
}
