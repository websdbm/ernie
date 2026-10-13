import { ContentBlock } from '@ernie/protocol';
import { describe, expect, it } from 'vitest';
import { createHealthTools, type HealthToolStore, shortDate } from './health.js';

const row = (date: string, value: number) => ({
  label: 'Glicemia',
  date,
  value,
  valueText: null,
  unit: 'mg/dL',
  refLow: 70,
  refHigh: 110,
  refText: null,
  flag: value > 110 ? ('alto' as const) : ('normale' as const),
});

const store: HealthToolStore = {
  overview: async () => ({ reports: [], parameters: [{ label: 'Glicemia', count: 2 }] }),
  parameter: async (_u, name) =>
    name === 'glucosio'
      ? { label: 'Glicemia', rows: [row('2026-03-02', 98), row('2026-10-10', 118)], trend: 'su' }
      : null,
  report: async () => ({
    takenOn: '2026-10-10',
    lab: 'Lab Rossi',
    kind: 'analisi del sangue',
    againstDate: '2026-03-02',
    rows: [
      {
        ...row('2026-10-10', 118),
        previous: { value: 98, date: '2026-03-02' },
        trend: 'su' as const,
      },
    ],
  }),
  importDocument: async () => ({ ok: true }),
};

describe('tool della salute: tabellina', () => {
  const tools = createHealthTools(store);
  const byId = (id: string) => {
    const t = tools.find((x) => x.id === id);
    if (!t) throw new Error(id);
    return t;
  };

  it('storico di un parametro → blocco valido, dal più recente', async () => {
    const t = byId('health_parameter');
    const out = await t.execute({ parameter: 'glucosio' }, {} as never);
    const block = t.present?.({ parameter: 'glucosio' }, out as never);
    const parsed = ContentBlock.parse(block);
    expect(parsed).toMatchObject({
      kind: 'health',
      mode: 'parameter',
      title: 'Glicemia',
      subtitle: '2 misure · in salita',
    });
    if (parsed.kind !== 'health') throw new Error('kind');
    expect(parsed.rows.map((r) => r.value)).toEqual([118, 98]);
  });

  it('parametro assente → nessun blocco e i parametri disponibili', async () => {
    const t = byId('health_parameter');
    const out = (await t.execute({ parameter: 'ferritina' }, {} as never)) as {
      found: boolean;
      known: string[];
    };
    expect(out).toMatchObject({ found: false, known: ['Glicemia'] });
    expect(t.present?.({ parameter: 'ferritina' }, out as never)).toBeNull();
  });

  it('referto con confronto → blocco valido con riassunto dei fuori intervallo', async () => {
    const t = byId('health_report');
    const out = await t.execute({}, {} as never);
    const parsed = ContentBlock.parse(t.present?.({}, out as never));
    expect(parsed).toMatchObject({
      kind: 'health',
      mode: 'report',
      title: 'Analisi del sangue del 10 ott 2026',
      subtitle: 'Lab Rossi · confronto con il 2 mar 2026',
      summary: '1 valore fuori intervallo: Glicemia alto.',
    });
    expect(shortDate('2026-01-05')).toBe('5 gen 2026');
  });
});
