import type { Automation, AutomationRepository } from '@ernie/automations';
import type { SentinelFrequency, SentinelInfo, SentinelStore } from '@ernie/tools';

/** Sentinelle come automazioni guidate `sentinella_*` (ricerca 11, C4 + C5). */
export const SENTINEL_PREFIX = 'sentinella_';

export function cronFor(
  frequency: SentinelFrequency,
  time = '09:00',
): { pattern: string; label: string } {
  const [h = '9', m = '0'] = time.split(':');
  const hh = Number(h);
  const mm = Number(m);
  if (frequency === 'ogni_ora')
    return { pattern: '0 8-22 * * *', label: 'ogni ora dalle 8 alle 22' };
  if (frequency === 'ogni_settimana')
    return { pattern: `${mm} ${hh} * * 1`, label: `ogni lunedì alle ${time}` };
  return { pattern: `${mm} ${hh} * * *`, label: `ogni giorno alle ${time}` };
}

const scheduleLabel = (a: Automation) =>
  a.trigger.type === 'cron'
    ? a.trigger.pattern === '0 8-22 * * *'
      ? 'ogni ora dalle 8 alle 22'
      : a.trigger.pattern.endsWith('* * 1')
        ? `ogni lunedì alle ${a.trigger.pattern.split(' ')[1]?.padStart(2, '0')}:${a.trigger.pattern.split(' ')[0]?.padStart(2, '0')}`
        : `ogni giorno alle ${a.trigger.pattern.split(' ')[1]?.padStart(2, '0')}:${a.trigger.pattern.split(' ')[0]?.padStart(2, '0')}`
    : 'su evento';

const toInfo = (a: Automation): SentinelInfo => ({
  id: a.id,
  title: a.title,
  condition: a.condition ?? '',
  schedule: scheduleLabel(a),
  url: a.check?.url ?? null,
  enabled: a.enabled,
  pausedReason: a.pausedReason,
  once: a.meta?.once === true,
});

export function createSentinelStore(deps: {
  automations: AutomationRepository;
  knownTools: readonly string[];
  maxBudgetUsd: number;
}): SentinelStore {
  return {
    async create(userId, s) {
      const { pattern } = cronFor(s.frequency, s.time);
      const tools = s.url ? ['web_fetch'] : ['web_search', 'web_fetch'];
      const available = tools.filter((t) => deps.knownTools.includes(t));
      if (!available.length) throw new Error('ricerca web non disponibile su questo server');
      const a = await deps.automations.create(
        userId,
        {
          key: `${SENTINEL_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          title: s.title,
          trigger: { type: 'cron', pattern },
          action: {
            type: 'guided',
            instructions: `Sentinella «${s.title}»: ${s.what}. ${
              s.url
                ? `Leggi ${s.url} con web_fetch (il cambiamento rilevato è tra i dati ricevuti).`
                : 'Cerca con web_search e, se serve, leggi le pagine con web_fetch.'
            } Poi decidi se la condizione è vera. Il messaggio di avviso deve essere breve e dire cosa è successo.`,
            allowedTools: available,
            modelClass: 'standard',
            contextTags: [],
          },
          budgetUsd: Math.min(0.05, deps.maxBudgetUsd),
          notifyPolicy: 'if_condition',
          condition: s.condition,
          ...(s.once ? { meta: { once: true } } : {}),
          ...(s.url
            ? {
                check: {
                  type: s.source === 'feed' ? 'feed_new_items' : 'page_changed',
                  url: s.url,
                },
              }
            : {}),
        },
        { knownTools: deps.knownTools, maxBudgetUsd: deps.maxBudgetUsd },
      );
      return toInfo(a);
    },
    async list(userId) {
      return (await deps.automations.list(userId))
        .filter((a) => a.key.startsWith(SENTINEL_PREFIX))
        .map(toInfo);
    },
    async remove(userId, id) {
      const a = await deps.automations.get(userId, id);
      if (!a?.key.startsWith(SENTINEL_PREFIX)) return false;
      return deps.automations.remove(userId, id);
    },
  };
}
