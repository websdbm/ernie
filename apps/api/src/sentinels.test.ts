import type { AutomationRepository } from '@ernie/automations';
import { describe, expect, it } from 'vitest';
import { createSentinelStore, cronFor, SENTINEL_PREFIX } from './sentinels.js';

describe('sentinelle', () => {
  it('orari: ogni ora solo di giorno (mai nella fascia notturna), giornaliera e settimanale', () => {
    expect(cronFor('ogni_ora').pattern).toBe('0 8-22 * * *');
    expect(cronFor('ogni_giorno', '07:30').pattern).toBe('30 7 * * *');
    expect(cronFor('ogni_settimana').pattern).toBe('0 9 * * 1');
  });

  it('crea un’automazione guidata con controllo e avviso a condizione; elenca e toglie solo le sentinelle', async () => {
    const created: unknown[] = [];
    const repo = {
      create: async (_u: string, input: Record<string, unknown>) => {
        created.push(input);
        return {
          id: '00000000-0000-4000-8000-000000000001',
          key: input.key,
          title: input.title,
          trigger: input.trigger,
          condition: input.condition,
          check: input.check,
          enabled: true,
          pausedReason: null,
        };
      },
      list: async () => [
        {
          id: 'a',
          key: `${SENTINEL_PREFIX}x`,
          title: 'S',
          trigger: { type: 'cron', pattern: '0 9 * * *' },
          condition: 'c',
          check: null,
          enabled: true,
          pausedReason: null,
        },
        {
          id: 'b',
          key: 'promemoria_y',
          title: 'P',
          trigger: { type: 'once', at: '' },
          enabled: true,
        },
      ],
      get: async (_u: string, id: string) => (id === 'b' ? { key: 'promemoria_y' } : null),
      remove: async () => true,
    } as unknown as AutomationRepository;
    const store = createSentinelStore({
      automations: repo,
      knownTools: ['web_fetch', 'web_search'],
      maxBudgetUsd: 0.5,
    });
    const s = await store.create('u', {
      title: 'Versione 2.0',
      what: 'controlla le versioni',
      condition: 'esce la 2.0',
      url: 'https://esempio.it/versioni',
      frequency: 'ogni_giorno',
    });
    expect(s).toMatchObject({
      title: 'Versione 2.0',
      condition: 'esce la 2.0',
      url: 'https://esempio.it/versioni',
      schedule: 'ogni giorno alle 09:00',
    });
    expect(created[0]).toMatchObject({
      notifyPolicy: 'if_condition',
      check: { type: 'page_changed', url: 'https://esempio.it/versioni' },
      action: { type: 'guided', allowedTools: ['web_fetch'] },
      budgetUsd: 0.05,
    });
    expect((await store.list('u')).map((x) => x.id)).toEqual(['a']);
    expect(await store.remove('u', 'b')).toBe(false); // un promemoria non si toglie come sentinella
  });
});
