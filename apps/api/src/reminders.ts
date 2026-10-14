import {
  type Automation,
  type AutomationQueue,
  type AutomationRepository,
  dedupeKeys,
  enqueueRun,
  nextOccurrences,
  type ProactiveCandidate,
} from '@ernie/automations';
import type { ContentBlock } from '@ernie/protocol';
import {
  formatWhen,
  REMINDER_FIRE_PREFIX,
  type Reminder,
  type ReminderChannels,
  type ReminderRepeat,
  type ReminderStore,
  repeatCron,
  repeatLabel,
  tidyReminderText,
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
  /** Email della scheda anagrafica: letta per i promemoria via email, salvata quando l'utente la dice. */
  readonly email?: {
    get(userId: string): Promise<string | null>;
    set(userId: string, email: string): Promise<boolean>;
  };
  /** Titolo breve dalla frase detta (modello leggero con ripiego deterministico); senza, pulizia deterministica. */
  readonly title?: (text: string, ctx: { userId: string; fromLabel?: string }) => Promise<string>;
}

const KEY_PREFIX = 'promemoria_';

interface Meta {
  readonly from?: string;
  readonly fromLabel?: string;
  readonly toLabel?: string;
  /** v1.11: canali scelti per questo promemoria (email, sveglia); assenti = impostazioni generali. */
  readonly channels?: ReminderChannels;
  /** Frase detta dall'utente (prima del titolo breve): va nell'email del promemoria. */
  readonly spoken?: string;
  /** v1.11: ricorrenza (l'automazione ha un trigger cron) e la sua frase per l'email. */
  readonly repeat?: ReminderRepeat;
  readonly repeatLabel?: string;
}

function repeatOf(v: unknown): ReminderRepeat | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (r.kind !== 'daily' && r.kind !== 'weekly' && r.kind !== 'monthly') return undefined;
  if (typeof r.hour !== 'number' || typeof r.minute !== 'number') return undefined;
  const weekdays = Array.isArray(r.weekdays)
    ? r.weekdays.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
    : undefined;
  return {
    kind: r.kind,
    hour: r.hour,
    minute: r.minute,
    ...(weekdays?.length ? { weekdays } : {}),
    ...(typeof r.day === 'number' ? { day: r.day } : {}),
  };
}

function channelsOf(v: unknown): ReminderChannels | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const c = v as Record<string, unknown>;
  const out = {
    ...(typeof c.email === 'boolean' ? { email: c.email } : {}),
    ...(typeof c.alarm === 'boolean' ? { alarm: c.alarm } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

const metaOf = (a: Automation): Meta => {
  const m = a.meta as Record<string, unknown>;
  const channels = channelsOf(m.channels);
  return {
    ...(typeof m.from === 'string' ? { from: m.from } : {}),
    ...(typeof m.fromLabel === 'string' ? { fromLabel: m.fromLabel } : {}),
    ...(typeof m.toLabel === 'string' ? { toLabel: m.toLabel } : {}),
    ...(channels ? { channels } : {}),
    ...(typeof m.spoken === 'string' ? { spoken: m.spoken } : {}),
    ...(repeatOf(m.repeat) ? { repeat: repeatOf(m.repeat) as ReminderRepeat } : {}),
    ...(typeof m.repeatLabel === 'string' ? { repeatLabel: m.repeatLabel } : {}),
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
  a.key.startsWith(KEY_PREFIX) &&
  a.enabled &&
  (a.trigger.type === 'once' || a.trigger.type === 'cron');

/** Quando suona: l'istante delle una tantum, la prossima occorrenza delle ricorrenti. */
function nextAt(a: Automation, now = new Date()): Date | null {
  if (a.trigger.type === 'once') return new Date(a.trigger.at);
  if (a.trigger.type === 'cron')
    return nextOccurrences(a.trigger.pattern, a.timezone, now, 1)[0] ?? null;
  return null;
}

/** Vista di un'automazione-promemoria per chi guarda: propria (eventualmente «da papà») o messa a un altro. */
function toReminder(a: Automation, viewer: string, forLabel?: string): Reminder | null {
  if (!isReminder(a)) return null;
  const at = nextAt(a);
  if (!at) return null;
  const meta = metaOf(a);
  const base = {
    id: a.id,
    text: textOf(a),
    at,
    status: 'scheduled' as const,
    ...(meta.channels ? { channels: meta.channels } : {}),
    ...(meta.repeat ? { repeat: meta.repeat } : {}),
  };
  if (a.userId === viewer)
    return meta.from && meta.from !== viewer && meta.fromLabel
      ? { ...base, from: meta.fromLabel }
      : base;
  if (meta.from === viewer) return { ...base, for: forLabel ?? meta.toLabel ?? 'familiare' };
  return null;
}

/** Stessa frase a meno di maiuscole e spazi: non serve conservarla a parte. */
const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300);

function hourMinute(at: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0),
    minute: Number(parts.find((p) => p.type === 'minute')?.value ?? 0),
  };
}

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
    // Ricorrente: trigger cron (lo pianifica il worker al prossimo giro); una tantum: job ritardato subito.
    const trigger = meta.repeat
      ? { type: 'cron' as const, pattern: repeatCron(meta.repeat) }
      : { type: 'once' as const, at: at.toISOString() };
    const fullMeta: Meta = meta.repeat ? { ...meta, repeatLabel: repeatLabel(meta.repeat) } : meta;
    const automation = await deps.automations.create(
      recipient,
      {
        key,
        title: title.slice(0, 120),
        trigger,
        timezone,
        budgetUsd: 0,
        catchUp: 'latest',
        jitterSeconds: 0,
        notify: true,
        enabled: true,
        action: { type: 'skill', skillId: 'ricordami', input },
        meta: fullMeta,
      },
      { knownTools: deps.knownTools, maxBudgetUsd: deps.maxBudgetUsd },
    );
    if (meta.repeat) return automation;
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
      const spoken = clean(input.text);
      const at = new Date(Math.floor(input.at.getTime() / 1000) * 1000);
      // Titolo breve dalla frase detta; dal punto di vista di chi lo riceve («chiamarmi» → «Chiamare papà»).
      const titled = async (fromLabel?: string) =>
        clean(
          deps.title
            ? await deps.title(spoken, { userId, ...(fromLabel ? { fromLabel } : {}) })
            : tidyReminderText(spoken),
        ) || spoken;
      if (!input.forLabel) {
        const text = input.literalTitle ? spoken : await titled();
        const a = await insert(userId, text, at, input.timezone, {
          ...(!sameText(spoken, text) ? { spoken } : {}),
          ...(input.repeat ? { repeat: input.repeat } : {}),
          ...(input.channels ? { channels: input.channels } : {}),
        });
        return {
          id: a.id,
          text,
          at: nextAt(a) ?? at,
          status: 'scheduled',
          ...(input.repeat ? { repeat: input.repeat } : {}),
          ...(input.channels ? { channels: input.channels } : {}),
        };
      }
      const link = deps.family ? await deps.family.find(userId, input.forLabel) : null;
      if (!link) throw new UnknownPersonError(input.forLabel);
      const fromLabel = (await deps.family?.labelFor(link.otherUserId, userId)) ?? 'un familiare';
      const text = input.literalTitle ? spoken : await titled(fromLabel);
      const meta: Meta = {
        from: userId,
        fromLabel,
        toLabel: link.label,
        ...(!sameText(spoken, text) ? { spoken } : {}),
        ...(input.repeat ? { repeat: input.repeat } : {}),
      };
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
    ...(deps.email
      ? {
          emailAddress: (userId: string) => deps.email?.get(userId) ?? Promise.resolve(null),
          setEmail: (userId: string, email: string) =>
            deps.email?.set(userId, email) ?? Promise.resolve(false),
        }
      : {}),
    async remove(userId, id) {
      const found = await locate(userId, id);
      if (!found) return false;
      return deps.automations.remove(found.owner, id);
    },
    async update(userId, id, patch) {
      const found = await locate(userId, id);
      if (!found) return null;
      // Solo i canali: si aggiornano i metadati sul posto (stesso id, il job ritardato resta quello).
      if (patch.channels && patch.text === undefined && patch.at === undefined) {
        const merged = { ...(metaOf(found.automation).channels ?? {}), ...patch.channels };
        const a = await deps.automations.mergeMeta(found.owner, id, { channels: merged });
        if (!a) return null;
        return toReminder(a, userId, found.forLabel);
      }
      // Testo o ora: le automazioni una tantum non si modificano, si sostituiscono (nuovo id), così il job
      // ritardato è coerente.
      const text = clean(patch.text ?? textOf(found.automation));
      const old = metaOf(found.automation);
      const at = patch.at
        ? new Date(Math.floor(patch.at.getTime() / 1000) * 1000)
        : (nextAt(found.automation) ?? new Date(0));
      if (!text || (!old.repeat && at.getTime() <= Date.now())) return null;
      // Ricorrente con nuova ora: stessa ricorrenza, ora e minuti presi dal nuovo istante (nel suo fuso).
      const repeat =
        old.repeat && patch.at
          ? { ...old.repeat, ...hourMinute(at, found.automation.timezone) }
          : old.repeat;
      const channels = patch.channels
        ? { ...(old.channels ?? {}), ...patch.channels }
        : old.channels;
      const meta: Meta = {
        ...old,
        ...(channels ? { channels } : {}),
        ...(repeat ? { repeat } : {}),
      };
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
