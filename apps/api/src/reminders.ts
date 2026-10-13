import {
  type Automation,
  type AutomationQueue,
  type AutomationRepository,
  dedupeKeys,
  enqueueRun,
  type ProactiveCandidate,
} from '@ernie/automations';
import type { ContentBlock } from '@ernie/protocol';
import {
  formatWhen,
  REMINDER_FIRE_PREFIX,
  type Reminder,
  type ReminderStore,
  toRemindersBlock,
  UnknownPersonError,
} from '@ernie/skills';
import type { FamilyRepository } from './family.js';

/**
 * I promemoria sono automazioni una tantum (`promemoria_<id>`): all'ora stabilita il worker esegue la skill
 * «Ricordami» con l'input `__promemoria__ <testo>` e la notifica parte dal runner (scheda, push, email).
 * Il job ritardato viene accodato subito (non si aspetta la sincronizzazione periodica), così valgono
 * anche i «tra 2 minuti».
 *
 * Famiglia: «ricorda a Giorgio di …» crea l'automazione nell'account di Giorgio (è il suo telefono a
 * suonare) con `meta.from` = chi l'ha messa; chi l'ha messa la vede nel proprio elenco («per Giorgio»)
 * e può annullarla o cambiarla; Giorgio la vede come «da papà».
 */
export interface ReminderStoreDeps {
  readonly automations: AutomationRepository;
  readonly queue: AutomationQueue;
  readonly knownTools: readonly string[];
  readonly maxBudgetUsd: number;
  /** Collegamenti famigliari con etichetta: senza, i promemoria a terzi non sono disponibili. */
  readonly family?: FamilyRepository;
  /** Avvisa subito il destinatario (scheda nelle sessioni connesse): la notifica locale parte da lì. */
  readonly notifyRecipient?: (userId: string, block: ContentBlock) => Promise<void>;
  /**
   * Gate della proattività (M9 A3): l'avviso «papà ti ha messo un promemoria» è un messaggio spontaneo
   * per chi lo riceve, quindi rispetta ore di quiete, tetto giornaliero e interruttore. Il promemoria in sé
   * suona comunque all'ora scelta.
   */
  readonly proactive?: (c: ProactiveCandidate) => Promise<unknown>;
}

const KEY_PREFIX = 'promemoria_';

interface Meta {
  readonly from?: string;
  readonly fromLabel?: string;
  readonly toLabel?: string;
}

const metaOf = (a: Automation): Meta => {
  const m = a.meta as Record<string, unknown>;
  return {
    ...(typeof m.from === 'string' ? { from: m.from } : {}),
    ...(typeof m.fromLabel === 'string' ? { fromLabel: m.fromLabel } : {}),
    ...(typeof m.toLabel === 'string' ? { toLabel: m.toLabel } : {}),
  };
};

function textOf(a: Automation): string {
  const input = a.action.type === 'skill' ? (a.action.input ?? '') : '';
  const raw = input.startsWith(REMINDER_FIRE_PREFIX)
    ? input.slice(REMINDER_FIRE_PREFIX.length)
    : a.title.replace(/^Promemoria(?: da [^:]+)?:\s*/u, '');
  return raw.replace(/^\[da [^\]]+\]\s*/u, '').trim();
}

const isReminder = (a: Automation): boolean =>
  a.key.startsWith(KEY_PREFIX) && a.enabled && a.trigger.type === 'once';

/** Vista di un'automazione-promemoria per chi guarda: propria (eventualmente «da papà») o messa a un altro. */
function toReminder(a: Automation, viewer: string, forLabel?: string): Reminder | null {
  if (!isReminder(a) || a.trigger.type !== 'once') return null;
  const meta = metaOf(a);
  const base = {
    id: a.id,
    text: textOf(a),
    at: new Date(a.trigger.at),
    status: 'scheduled' as const,
  };
  if (a.userId === viewer)
    return meta.from && meta.from !== viewer && meta.fromLabel
      ? { ...base, from: meta.fromLabel }
      : base;
  if (meta.from === viewer) return { ...base, for: forLabel ?? meta.toLabel ?? 'familiare' };
  return null;
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300);

export function createReminderStore(deps: ReminderStoreDeps): ReminderStore {
  /** Inserisce l'automazione nell'account del destinatario e accoda il job all'ora stabilita. */
  const insert = async (
    recipient: string,
    text: string,
    at: Date,
    timezone: string,
    meta: Meta,
  ): Promise<Automation> => {
    const key = `${KEY_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const title = meta.fromLabel
      ? `Promemoria da ${meta.fromLabel}: ${text}`
      : `Promemoria: ${text}`;
    const input = meta.fromLabel
      ? `${REMINDER_FIRE_PREFIX}[da ${meta.fromLabel}] ${text}`
      : `${REMINDER_FIRE_PREFIX}${text}`;
    const automation = await deps.automations.create(
      recipient,
      {
        key,
        title: title.slice(0, 120),
        trigger: { type: 'once', at: at.toISOString() },
        timezone,
        budgetUsd: 0,
        catchUp: 'latest',
        jitterSeconds: 0,
        notify: true,
        enabled: true,
        action: { type: 'skill', skillId: 'ricordami', input },
        meta,
      },
      { knownTools: deps.knownTools, maxBudgetUsd: deps.maxBudgetUsd },
    );
    await enqueueRun(
      deps.queue,
      {
        automationId: automation.id,
        userId: recipient,
        scheduledAt: at.toISOString(),
        dedupeKey: dedupeKeys.once(at),
        triggerType: 'once',
        depth: 0,
      },
      Math.max(0, at.getTime() - Date.now()),
    );
    return automation;
  };

  /** Trova il promemoria `id` tra i propri o tra quelli messi a persone collegate. */
  const locate = async (
    userId: string,
    id: string,
  ): Promise<{ owner: string; automation: Automation; forLabel?: string } | null> => {
    const own = await deps.automations.get(userId, id);
    if (own) return isReminder(own) ? { owner: userId, automation: own } : null;
    if (!deps.family) return null;
    for (const link of await deps.family.list(userId)) {
      const a = await deps.automations.get(link.otherUserId, id);
      if (a && isReminder(a) && metaOf(a).from === userId)
        return { owner: link.otherUserId, automation: a, forLabel: link.label };
    }
    return null;
  };

  const announce = async (recipient: string, r: Reminder, fromLabel: string, timezone: string) => {
    if (deps.proactive) {
      try {
        await deps.proactive({
          userId: recipient,
          kind: 'family_reminder',
          dedupeKey: `family_reminder:${r.id}`,
          title: `${fromLabel} ti ha messo un promemoria`,
          body: `${r.text} (${formatWhen(r.at, timezone)})`,
          payload: {
            reminderId: r.id,
            at: r.at.toISOString(),
            block: toRemindersBlock([r], `Promemoria da ${fromLabel}`),
          },
          evidence: { source: 'family', refs: [`automations:${r.id}`] },
        });
      } catch {
        /* avviso non riuscito: all'ora stabilita il worker notifica comunque */
      }
      return;
    }
    try {
      await deps.automations.notify(recipient, {
        kind: 'reminder.assigned',
        title: `${fromLabel} ti ha messo un promemoria`,
        body: `${r.text} (${formatWhen(r.at, timezone)})`,
        payload: { reminderId: r.id, at: r.at.toISOString() },
      });
      await deps.notifyRecipient?.(recipient, toRemindersBlock([r], `Promemoria da ${fromLabel}`));
    } catch {
      /* avviso immediato non riuscito: all'ora stabilita il worker notifica comunque */
    }
  };

  return {
    async create(userId, input) {
      const text = clean(input.text);
      const at = new Date(Math.floor(input.at.getTime() / 1000) * 1000);
      if (!input.forLabel) {
        const a = await insert(userId, text, at, input.timezone, {});
        return { id: a.id, text, at, status: 'scheduled' };
      }
      const link = deps.family ? await deps.family.find(userId, input.forLabel) : null;
      if (!link) throw new UnknownPersonError(input.forLabel);
      const fromLabel = (await deps.family?.labelFor(link.otherUserId, userId)) ?? 'un familiare';
      const meta: Meta = { from: userId, fromLabel, toLabel: link.label };
      const a = await insert(link.otherUserId, text, at, input.timezone, meta);
      await announce(
        link.otherUserId,
        { id: a.id, text, at, status: 'scheduled', from: fromLabel },
        fromLabel,
        input.timezone,
      );
      return { id: a.id, text, at, status: 'scheduled', for: link.label };
    },
    async list(userId) {
      const now = Date.now();
      const out: Reminder[] = [];
      const consider = (all: Automation[], forLabel?: string) => {
        for (const a of all) {
          const r = toReminder(a, userId, forLabel);
          if (r && r.at.getTime() >= now - 60_000) out.push(r);
        }
      };
      consider(await deps.automations.list(userId));
      if (deps.family)
        for (const link of await deps.family.list(userId))
          consider(await deps.automations.list(link.otherUserId), link.label);
      return out.sort((x, y) => x.at.getTime() - y.at.getTime());
    },
    async remove(userId, id) {
      const found = await locate(userId, id);
      if (!found) return false;
      return deps.automations.remove(found.owner, id);
    },
    async update(userId, id, patch) {
      // Le automazioni una tantum non si modificano: si sostituisce (nuovo id), così il job ritardato è coerente.
      const found = await locate(userId, id);
      if (found?.automation.trigger.type !== 'once') return null;
      const text = clean(patch.text ?? textOf(found.automation));
      const at = patch.at
        ? new Date(Math.floor(patch.at.getTime() / 1000) * 1000)
        : new Date(found.automation.trigger.at);
      if (!text || at.getTime() <= Date.now()) return null;
      const meta = metaOf(found.automation);
      await deps.automations.remove(found.owner, id);
      const a = await insert(found.owner, text, at, found.automation.timezone, meta);
      const r = toReminder(a, userId, found.forLabel);
      if (found.forLabel && meta.fromLabel)
        await announce(
          found.owner,
          { id: a.id, text, at, status: 'scheduled', from: meta.fromLabel },
          meta.fromLabel,
          found.automation.timezone,
        );
      return r ?? { id: a.id, text, at, status: 'scheduled' };
    },
  };
}
