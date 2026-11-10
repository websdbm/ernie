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
    id: '00000000-0000-4000-8000-000000000001',
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

  it('an undated report remains readable by id and renders without an invented date', async () => {
    let selected: { reportId?: string } | undefined;
    const id = '00000000-0000-4000-8000-000000000002';
    const undated: HealthToolStore = {
      ...store,
      report: async (_user, query) => {
        selected = query;
        return {
          id,
          takenOn: null,
          lab: 'Laboratorio sintetico',
          kind: 'analisi',
          againstDate: null,
          rows: [{ ...row('', 95), date: null }],
        };
      },
      importDocument: async () => ({ ok: true, takenOn: null, values: 1 }),
      overview: async () => ({
        reports: [{ id, takenOn: null, lab: null, kind: 'analisi', values: 1, outOfRange: 0 }],
        parameters: [],
      }),
    };
    const tools = createHealthTools(undated);
    const report = tools.find((tool) => tool.id === 'health_report');
    if (!report) throw Error('missing report');
    const args = { reportId: id };
    expect(report.inputSchema.safeParse(args).success).toBe(true);
    const out = await report.execute(args, {} as never);
    expect(selected).toEqual(args);
    expect(report.outputSchema.safeParse(out).success).toBe(true);
    const block = ContentBlock.parse(report.present?.(args, out));
    expect(block).toMatchObject({ title: 'Analisi · data non disponibile', mode: 'report' });
    if (block.kind !== 'health') throw Error('wrong block');
    expect(block.rows[0]).not.toHaveProperty('date');
    for (const tool of tools.filter((tool) =>
      ['health_overview', 'health_import'].includes(tool.id),
    )) {
      expect(
        tool.outputSchema.safeParse(await tool.execute({ documentId: id }, {} as never)).success,
      ).toBe(true);
    }
  });

  it('keeps undated parameter values after the dated rows without putting them in the timeline', async () => {
    const tools = createHealthTools({
      ...store,
      parameter: async () => ({
        label: 'Glicemia',
        trend: null,
        rows: [{ ...row('', 800), date: null }, row('2026-10-10', 95)],
      }),
    });
    const parameter = tools.find((tool) => tool.id === 'health_parameter');
    if (!parameter) throw Error('missing parameter');
    const out = await parameter.execute({ parameter: 'Glicemia' }, {} as never);
    const block = ContentBlock.parse(parameter.present?.({}, out));
    if (block.kind !== 'health') throw Error('wrong block');
    expect(block.subtitle).toBe('2 misure · 1 senza data');
    expect(block.rows.map((row) => row.value)).toEqual([95, 800]);
    expect(block.rows[1]).not.toHaveProperty('date');
  });

  it.each([
    [{ ...row('', 90), refLow: null, refHigh: null, flag: 'n/d' as const }],
    [{ ...row('', 90), refLow: null, refHigh: null, flag: 'normale' as const }],
    [row('', 90), { ...row('', 88), refLow: null, refHigh: null, flag: 'n/d' as const }],
    [{ ...row('', 90), value: null, valueText: 'negativo', flag: 'n/d' as const }],
  ])('does not declare everything normal without comparable references: %j', async (...rows) => {
    const tools = createHealthTools({
      ...store,
      report: async () => ({
        id: 'x',
        takenOn: null,
        lab: null,
        kind: 'analisi',
        againstDate: null,
        rows,
      }),
    });
    const tool = tools.find((tool) => tool.id === 'health_report');
    if (!tool) throw Error('missing report');
    const out = await tool.execute({}, {} as never);
    const parsed = ContentBlock.parse(tool.present?.({}, out));
    if (parsed.kind !== 'health') throw Error('wrong block');
    expect(parsed.summary).toContain('confronto non è determinabile');
    expect(parsed.summary).not.toMatch(/tutti.*intervallo/i);
  });
});
