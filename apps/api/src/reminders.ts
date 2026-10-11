import {
  type AutomationQueue,
  type AutomationRepository,
  dedupeKeys,
  enqueueRun,
} from '@ernie/automations';
import { REMINDER_FIRE_PREFIX, type Reminder, type ReminderStore } from '@ernie/skills';

/**
 * I promemoria sono automazioni una tantum (`promemoria_<id>`): all'ora stabilita il worker esegue la skill
 * «Ricordami» con l'input `__promemoria__ <testo>` e la notifica parte dal runner (scheda, push, email).
 * Il job ritardato viene accodato subito (non si aspetta la sincronizzazione periodica), così valgono
 * anche i «tra 2 minuti».
 */
export interface ReminderStoreDeps {
  readonly automations: AutomationRepository;
  readonly queue: AutomationQueue;
  readonly knownTools: readonly string[];
  readonly maxBudgetUsd: number;
}

const KEY_PREFIX = 'promemoria_';

function textOf(a: { title: string; action: { type: string; input?: string } }): string {
  const input = a.action.type === 'skill' ? (a.action.input ?? '') : '';
  if (input.startsWith(REMINDER_FIRE_PREFIX))
    return input.slice(REMINDER_FIRE_PREFIX.length).trim();
  return a.title.replace(/^Promemoria:\s*/u, '').trim();
}

export function createReminderStore(deps: ReminderStoreDeps): ReminderStore {
  return {
    async create(userId, input) {
      const text = input.text.replace(/\s+/g, ' ').trim().slice(0, 300);
      const key = `${KEY_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const at = new Date(Math.floor(input.at.getTime() / 1000) * 1000);
      const automation = await deps.automations.create(
        userId,
        {
          key,
          title: `Promemoria: ${text}`.slice(0, 120),
          trigger: { type: 'once', at: at.toISOString() },
          timezone: input.timezone,
          budgetUsd: 0,
          catchUp: 'latest',
          jitterSeconds: 0,
          notify: true,
          enabled: true,
          action: { type: 'skill', skillId: 'ricordami', input: `${REMINDER_FIRE_PREFIX}${text}` },
        },
        { knownTools: deps.knownTools, maxBudgetUsd: deps.maxBudgetUsd },
      );
      await enqueueRun(
        deps.queue,
        {
          automationId: automation.id,
          userId,
          scheduledAt: at.toISOString(),
          dedupeKey: dedupeKeys.once(at),
          triggerType: 'once',
          depth: 0,
        },
        Math.max(0, at.getTime() - Date.now()),
      );
      return { id: automation.id, text, at, status: 'scheduled' };
    },
    async list(userId) {
      const now = Date.now();
      const all = await deps.automations.list(userId);
      const out: Reminder[] = [];
      for (const a of all) {
        if (!a.key.startsWith(KEY_PREFIX) || !a.enabled || a.trigger.type !== 'once') continue;
        const at = new Date(a.trigger.at);
        if (at.getTime() < now - 60_000) continue;
        out.push({ id: a.id, text: textOf(a), at, status: 'scheduled' });
      }
      return out.sort((x, y) => x.at.getTime() - y.at.getTime());
    },
    async remove(userId, id) {
      return deps.automations.remove(userId, id);
    },
  };
}
