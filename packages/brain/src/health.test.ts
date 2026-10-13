import { describe, expect, it } from 'vitest';
import {
  canonicalParameter,
  flagFor,
  healthIndexBody,
  healthNotices,
  healthReportPath,
  healthReportTitle,
  looksLikeLabReport,
  parameterNoteBody,
  parseNumber,
  parseRange,
  reportNoteBody,
  type SeriesPoint,
  toHealthValue,
  trendOf,
} from './health.js';

describe('sezione salute: nomi dei parametri', () => {
  it('GOT e AST, GPT e ALT, glucosio e glicemia finiscono sotto lo stesso parametro', () => {
    expect(canonicalParameter('GOT').key).toBe('ast');
    expect(canonicalParameter('AST (GOT)').key).toBe('ast');
    expect(canonicalParameter('S-GPT').key).toBe('alt');
    expect(canonicalParameter('Glucosio').key).toBe('glicemia');
    expect(canonicalParameter('GLICEMIA').label).toBe('Glicemia');
    expect(canonicalParameter('Emoglobina glicata (HbA1c)').key).toBe('emoglobina_glicata');
    expect(canonicalParameter('Colesterolo HDL (metodo diretto)').key).toBe('colesterolo_hdl');
    expect(canonicalParameter('Colesterolo totale').key).toBe('colesterolo_totale');
    expect(canonicalParameter('25-OH Vitamina D').key).toBe('vitamina_d');
    expect(canonicalParameter('Gamma-GT').key).toBe('gamma_gt');
    expect(canonicalParameter('Colesterolo non HDL').key).toBe('colesterolo_non_hdl');
    expect(canonicalParameter('Bilirubina indiretta').key).toBe('bilirubina_indiretta');
  });

  it('un parametro sconosciuto tiene il suo nome', () => {
    expect(toHealthValue({ name: 'OMOCISTEINA', value: '9' })?.label).toBe('Omocisteina');
    expect(toHealthValue({ name: 'PESO SPECIFICO', value: '1.020', section: 'urine' })?.label).toBe(
      'Peso specifico (urine)',
    );
    const p = canonicalParameter('omocisteina');
    expect(p).toEqual({ key: 'omocisteina', label: 'Omocisteina' });
  });
});

describe('sezione salute: numeri e intervalli all’italiana', () => {
  it('legge la virgola decimale e i separatori delle migliaia', () => {
    expect(parseNumber('5,4')).toBe(5.4);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('12.5')).toBe(12.5);
    // Un solo punto resta decimale (peso specifico 1.020); con il riferimento nello stesso formato il confronto regge.
    expect(parseNumber('1.020')).toBe(1.02);
    expect(parseNumber('negativo')).toBeNull();
    expect(parseNumber('< 0,5')).toBeNull();
  });

  it('legge gli intervalli di riferimento più comuni', () => {
    expect(parseRange('70 - 110')).toEqual({ low: 70, high: 110 });
    expect(parseRange('0,5–1,2')).toEqual({ low: 0.5, high: 1.2 });
    expect(parseRange('< 200')).toEqual({ low: null, high: 200 });
    expect(parseRange('> 40')).toEqual({ low: 40, high: null });
    expect(parseRange('fino a 35')).toEqual({ low: null, high: 35 });
    expect(parseRange('da 4 a 10')).toEqual({ low: 4, high: 10 });
    expect(parseRange('vedi nota')).toEqual({ low: null, high: null });
  });

  it('segna alto, basso, normale o n/d', () => {
    expect(flagFor(120, 70, 110)).toBe('alto');
    expect(flagFor(60, 70, 110)).toBe('basso');
    expect(flagFor(90, 70, 110)).toBe('normale');
    expect(flagFor(90, null, null)).toBe('n/d');
    expect(flagFor(null, 70, 110)).toBe('n/d');
  });

  it('riga grezza → valore controllato; percentuali della formula a parte', () => {
    expect(toHealthValue({ name: 'GOT', value: '45', unit: 'U/L', ref: '< 35' })).toMatchObject({
      parameter: 'ast',
      label: 'AST (GOT)',
      value: 45,
      unit: 'U/L',
      refHigh: 35,
      flag: 'alto',
    });
    expect(
      toHealthValue({ name: 'Neutrofili', value: '55,2', unit: '%', ref: '40 - 75' }),
    ).toMatchObject({
      parameter: 'neutrofili_perc',
      label: 'Neutrofili %',
      flag: 'normale',
    });
    expect(toHealthValue({ name: 'Glucosio', value: 'assente', section: 'urine' })).toMatchObject({
      parameter: 'urine_glicemia',
      label: 'Glucosio (urine)',
    });
    expect(toHealthValue({ name: 'HCV', value: 'negativo' })).toMatchObject({
      value: null,
      valueText: 'negativo',
      flag: 'n/d',
    });
    expect(toHealthValue({ name: '', value: '3' })).toBeNull();
    expect(toHealthValue({ name: 'Ferro', value: '' })).toBeNull();
  });

  it('riconosce un referto di laboratorio e non una ricetta', () => {
    const referto = `LABORATORIO ANALISI CLINICHE
Esami ematochimici   Valori di riferimento
Glicemia 92 mg/dL 70-110
Colesterolo totale 210 mg/dL < 200
HDL 55 mg/dL > 40
Trigliceridi 120 mg/dL < 150
GOT 22 U/L < 35
GPT 30 U/L < 45
Emoglobina 14,2 g/dL 13-17`;
    expect(looksLikeLabReport(referto)).toBe(true);
    expect(looksLikeLabReport('Torta di mele: 200 g di farina, 3 uova, 100 g di zucchero.')).toBe(
      false,
    );
  });
});

const pt = (date: string, value: number, unit = 'mg/dL'): SeriesPoint => ({
  date,
  value,
  valueText: null,
  unit,
  flag: 'normale',
  refLow: 70,
  refHigh: 110,
});

describe('sezione salute: andamenti e avvisi', () => {
  it('andamento tra le ultime due misure con la stessa unità', () => {
    expect(trendOf([pt('2026-01-10', 90), pt('2026-05-10', 100)])).toBe('su');
    expect(trendOf([pt('2026-01-10', 100), pt('2026-05-10', 90)])).toBe('giu');
    expect(trendOf([pt('2026-01-10', 100), pt('2026-05-10', 101)])).toBe('stabile');
    expect(trendOf([pt('2026-01-10', 100), pt('2026-05-10', 5, 'mmol/L')])).toBeNull();
    expect(trendOf([pt('2026-01-10', 100)])).toBeNull();
  });

  it('avvisa dei fuori intervallo con i valori precedenti e dei peggioramenti vicino al limite', () => {
    const cur = toHealthValue({ name: 'Glicemia', value: '118', unit: 'mg/dL', ref: '70 - 110' });
    const near = toHealthValue({
      name: 'Colesterolo totale',
      value: '195',
      unit: 'mg/dL',
      ref: '< 200',
    });
    if (!cur || !near) throw new Error('valori');
    const history = new Map<string, SeriesPoint[]>([
      ['glicemia', [pt('2025-10-01', 95), pt('2026-03-01', 104), pt('2026-10-01', 118)]],
      [
        'colesterolo_totale',
        [
          { ...pt('2025-10-01', 170), refLow: null, refHigh: 200 },
          { ...pt('2026-03-01', 185), refLow: null, refHigh: 200 },
          { ...pt('2026-10-01', 195), refLow: null, refHigh: 200 },
        ],
      ],
    ]);
    const n = healthNotices([cur, near], history);
    expect(n[0]).toBe('Glicemia 118 mg/dL: alto (riferimento 70 - 110), prima 104 e 95.');
    expect(n[1]).toContain(
      'Colesterolo totale sale da tre analisi di fila (170 → 185 → 195 mg/dL)',
    );
  });

  it('nessun avviso se tutto è stabile e nell’intervallo', () => {
    const v = toHealthValue({ name: 'Glicemia', value: '90', unit: 'mg/dL', ref: '70 - 110' });
    if (!v) throw new Error('valore');
    expect(
      healthNotices([v], new Map([['glicemia', [pt('2026-01-01', 91), pt('2026-10-01', 90)]]])),
    ).toEqual([]);
  });
});

describe('sezione salute: note per il vault', () => {
  const values = [
    toHealthValue({ name: 'Glicemia', value: '118', unit: 'mg/dL', ref: '70 - 110' }),
    toHealthValue({ name: 'GOT', value: '20', unit: 'U/L', ref: '< 35' }),
  ].filter((v) => v !== null);

  it('nota del referto con tabella, fuori intervallo e rimando ai parametri', () => {
    const r = { takenOn: '2026-10-13', lab: 'Lab Rossi', kind: 'analisi del sangue' };
    expect(healthReportTitle(r)).toBe('Analisi del sangue del 13 ottobre 2026');
    expect(healthReportPath(healthReportTitle(r))).toBe(
      'Salute/Analisi/Analisi del sangue del 13 ottobre 2026.md',
    );
    const body = reportNoteBody(r, values);
    expect(body).toContain('# Analisi del sangue del 13 ottobre 2026');
    expect(body).toContain('Fuori intervallo: Glicemia.');
    expect(body).toContain('| [[Glicemia]] | 118 ⬆️ | mg/dL | 70 - 110 |');
    expect(body).toContain('| [[AST (GOT)]] | 20  | U/L | < 35 |');
  });

  it('pagina del parametro con lo storico dal più recente, e indice', () => {
    const body = parameterNoteBody('Glicemia', [pt('2026-03-01', 104), pt('2026-10-01', 118)]);
    expect(body.indexOf('1 ottobre 2026')).toBeLessThan(body.indexOf('1 marzo 2026'));
    expect(body).toContain('Ultimo andamento: in salita.');
    const idx = healthIndexBody(
      [{ title: 'Analisi del sangue del 13 ottobre 2026', values: 2, outOfRange: 1 }],
      [{ label: 'Glicemia', count: 2 }],
    );
    expect(idx).toContain(
      '- [[Analisi del sangue del 13 ottobre 2026]] · 2 valori, 1 fuori intervallo',
    );
    expect(idx).toContain('- [[Glicemia]] (2 misure)');
  });
});
