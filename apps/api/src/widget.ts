import { type Automation, type AutomationRun, nextOccurrences } from '@ernie/automations';
import type { Reminder } from '@ernie/skills';

/**
 * Riepilogo per il widget grande di Ernie (richiesta dell'utente, 15 ott 2026): prossimi impegni, automazioni
 * attive, ultima attività e stato. Una sola richiesta piccola, letta dal widget ogni mezz'ora.
 */
export interface WidgetSummary {
  readonly generatedAt: string;
  readonly status: {
    /** Interruttore di emergenza acceso: Ernie non esegue niente. */
    readonly paused: boolean;
    readonly proactive: boolean;
    readonly unread: number;
  };
  readonly reminders: ReadonlyArray<{
    id: string;
    text: string;
    at: string;
    eventAt?: string;
    from?: string;
  }>;
  readonly automations: ReadonlyArray<{
    id: string;
    title: string;
    kind: 'sentinella' | 'automazione';
    nextAt?: string;
    /** In pausa automatica dopo errori ripetuti. */
    paused: boolean;
  }>;
  readonly activity?: {
    readonly title: string;
    readonly status: AutomationRun['status'];
    readonly at: string;
    /** Sentinella che ha controllato senza novità. */
    readonly quiet: boolean;
  };
  readonly counts: { readonly reminders: number; readonly automations: number };
}

const REMINDER_KEY = 'promemoria_';
const MAX_REMINDERS = 4;
const MAX_AUTOMATIONS = 4;

function nextRun(a: Automation, now: Date): Date | null {
  if (a.trigger.type === 'once') {
    const at = new Date(a.trigger.at);
    return at > now ? at : null;
  }
  if (a.trigger.type === 'cron') {
    try {
      return nextOccurrences(a.trigger.pattern, a.timezone, now, 1)[0] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function buildWidgetSummary(input: {
  now: Date;
  settings: Readonly<Record<string, unknown>>;
  reminders: readonly Reminder[];
  automations: readonly Automation[];
  runs: readonly AutomationRun[];
  unread: number;
}): WidgetSummary {
  const { now } = input;
  const upcoming = input.reminders
    .filter((r) => r.status === 'scheduled' && !r.for && r.at.getTime() > now.getTime() - 60_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const active = input.automations
    .filter((a) => a.enabled && !a.key.startsWith(REMINDER_KEY))
    .map((a) => ({ a, next: nextRun(a, now) }))
    .filter(({ a, next }) => next !== null || a.trigger.type !== 'once')
    .sort(
      (x, y) =>
        (x.next?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (y.next?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );
  const titles = new Map(input.automations.map((a) => [a.id, a]));
  // Ultima attività visibile: le esecuzioni dei promemoria non contano (sono già nell'elenco sopra).
  const last = input.runs.find((r) => {
    const a = titles.get(r.automationId);
    return a && !a.key.startsWith(REMINDER_KEY) && r.status !== 'scheduled';
  });
  const lastAutomation = last ? titles.get(last.automationId) : undefined;
  return {
    generatedAt: now.toISOString(),
    status: {
      paused: input.settings.killSwitch === true,
      proactive: input.settings.proactive === true,
      unread: input.unread,
    },
    reminders: upcoming.slice(0, MAX_REMINDERS).map((r) => ({
      id: r.id,
      text: r.text,
      at: r.at.toISOString(),
      ...(r.eventAt ? { eventAt: r.eventAt.toISOString() } : {}),
      ...(r.from ? { from: r.from } : {}),
    })),
    automations: active.slice(0, MAX_AUTOMATIONS).map(({ a, next }) => ({
      id: a.id,
      title: a.title,
      kind: a.check || a.notifyPolicy === 'if_condition' ? 'sentinella' : 'automazione',
      ...(next ? { nextAt: next.toISOString() } : {}),
      paused: a.pausedReason !== null,
    })),
    ...(last && lastAutomation
      ? {
          activity: {
            title: lastAutomation.title,
            status: last.status,
            at: (last.finishedAt ?? last.startedAt ?? last.scheduledAt).toISOString(),
            quiet: last.outcome?.silent === true,
          },
        }
      : {}),
    counts: { reminders: upcoming.length, automations: active.length },
  };
}
