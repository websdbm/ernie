import type { ContentBlock } from '@ernie/protocol';
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

/**
 * Sezione salute del second brain (13 ott 2026): valori delle analisi letti dai referti caricati, storico per
 * parametro, confronto tra un'analisi e l'altra. Le risposte arrivano anche come «tabellina» (blocco `health`).
 * Qui c'è solo l'interfaccia per il modello; archivio, nomi dei parametri e calcoli stanno in @ernie/brain.
 */
type Flag = 'alto' | 'basso' | 'normale' | 'n/d';

export interface HealthToolRow {
  readonly label: string;
  readonly date?: string | null;
  readonly value: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly refLow: number | null;
  readonly refHigh: number | null;
  readonly refText: string | null;
  readonly flag: Flag;
  readonly previous?: { readonly value: number; readonly date: string };
  readonly trend?: 'su' | 'giu' | 'stabile';
}

export interface HealthToolStore {
  overview(userId: string): Promise<{
    reports: Array<{
      id: string;
      takenOn: string | null;
      lab: string | null;
      kind: string;
      values: number;
      outOfRange: number;
    }>;
    parameters: Array<{ label: string; count: number }>;
  }>;
  parameter(
    userId: string,
    name: string,
  ): Promise<{
    label: string;
    rows: HealthToolRow[];
    trend: 'su' | 'giu' | 'stabile' | null;
  } | null>;
  report(
    userId: string,
    q: { date?: string; against?: string; reportId?: string },
  ): Promise<{
    id: string;
    takenOn: string | null;
    lab: string | null;
    kind: string;
    againstDate: string | null;
    rows: HealthToolRow[];
  } | null>;
  importDocument(
    userId: string,
    documentId: string,
  ): Promise<{
    ok: boolean;
    reason?: string;
    takenOn?: string | null;
    values?: number;
    outOfRange?: string[];
  }>;
}

const Flag = z.enum(['alto', 'basso', 'normale', 'n/d']);
const Row = z.object({
  label: z.string(),
  date: z.string().nullable().optional(),
  value: z.number().nullable(),
  valueText: z.string().nullable(),
  unit: z.string().nullable(),
  refLow: z.number().nullable(),
  refHigh: z.number().nullable(),
  refText: z.string().nullable(),
  flag: Flag,
  previous: z.object({ value: z.number(), date: z.string() }).optional(),
  trend: z.enum(['su', 'giu', 'stabile']).optional(),
});

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
/** «2026-10-13» → «13 ott 2026». */
export const shortDate = (iso: string | null) => {
  if (!iso) return 'data non disponibile';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
};

const outOfRangeSummary = (rows: readonly z.infer<typeof Row>[]) => {
  const out = rows.filter((r) => r.flag === 'alto' || r.flag === 'basso');
  const unknown = rows.filter(
    (r) =>
      r.flag === 'n/d' ||
      r.value === null ||
      !Number.isFinite(r.value) ||
      (r.refLow === null && r.refHigh === null) ||
      (r.refLow !== null && r.refHigh !== null && r.refLow > r.refHigh),
  );
  const count = unknown.length;
  const missing = count
    ? `Per ${count === 1 ? '1 valore' : `${count} valori`} il confronto non è determinabile: riferimento assente o non interpretabile, oppure risultato non numerico.`
    : '';
  if (!out.length) {
    if (rows.length === 0) return 'Nessun valore disponibile per il confronto.';
    if (count === rows.length) return missing;
    if (count) {
      const comparable = rows.length - count;
      return `${comparable === 1 ? '1 valore confrontabile è' : `${comparable} valori confrontabili sono`} nell’intervallo riportato. ${missing}`;
    }
    return 'Tutti i valori sono nell’intervallo riportato nel referto.';
  }
  const list = out.map((r) => `${r.label} ${r.flag}`).join(', ');
  return [
    `${out.length === 1 ? '1 valore fuori intervallo' : `${out.length} valori fuori intervallo`}: ${list}.`.slice(
      0,
      180,
    ),
    missing,
  ]
    .filter(Boolean)
    .join(' ');
};

const blockRows = (rows: readonly z.infer<typeof Row>[]) =>
  rows.slice(0, 80).map((r) => ({
    label: r.label.slice(0, 80),
    ...(r.date ? { date: r.date } : {}),
    value: r.value,
    valueText: r.valueText,
    unit: r.unit,
    refLow: r.refLow,
    refHigh: r.refHigh,
    refText: r.refText,
    flag: r.flag,
    ...(r.previous ? { previous: r.previous } : {}),
    ...(r.trend ? { trend: r.trend } : {}),
  }));

const SHOWN =
  "L'app sta già mostrando all'utente la tabellina con questi valori: non ripeterla e non chiedere se mostrarla.";

const CAUTION =
  'Dati sanitari riservati. Spiega con prudenza e parole semplici, senza diagnosi né terapie; per valori fuori intervallo o dubbi suggerisci di parlarne con il medico.';

export function createHealthTools(store: HealthToolStore): ToolSpec[] {
  return [
    defineTool({
      id: 'health_parameter',
      version: '1',
      category: 'health',
      description:
        "Storico di un parametro delle analisi dell'utente (es. «colesterolo», «GOT», «glicemia», «vitamina D»): valori e riferimenti riportati. Le misure senza data restano consultabili ma sono escluse dall'andamento. L'app mostra la tabellina: commenta brevemente senza inventare riferimenti.",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({ parameter: z.string().min(1).max(80) }),
      outputSchema: z.object({
        found: z.boolean(),
        label: z.string().optional(),
        trend: z.enum(['su', 'giu', 'stabile']).nullable().optional(),
        rows: z.array(Row).optional(),
        known: z.array(z.string()).optional(),
        shown: z.string().optional(),
        caution: z.string(),
      }),
      execute: async ({ parameter }, ctx) => {
        const r = await store.parameter(ctx.userId, parameter);
        if (!r) {
          const o = await store.overview(ctx.userId);
          return {
            found: false,
            known: o.parameters.map((p) => p.label).slice(0, 60),
            caution: CAUTION,
          };
        }
        return {
          found: true,
          label: r.label,
          trend: r.trend,
          rows: r.rows,
          shown: SHOWN,
          caution: CAUTION,
        };
      },
      present: (_i, out): ContentBlock | null =>
        out.found && out.label && out.rows?.length
          ? {
              kind: 'health',
              mode: 'parameter',
              title: out.label.slice(0, 120),
              subtitle: `${out.rows.length === 1 ? '1 misura' : `${out.rows.length} misure`}${out.rows.some((r) => !r.date) ? ` · ${out.rows.filter((r) => !r.date).length} senza data` : ''}${
                out.trend
                  ? ` · ${out.trend === 'su' ? 'in salita' : out.trend === 'giu' ? 'in discesa' : 'stabile'}`
                  : ''
              }`,
              rows: blockRows(
                [...out.rows].sort((a, b) =>
                  a.date && b.date ? b.date.localeCompare(a.date) : a.date ? -1 : b.date ? 1 : 0,
                ),
              ),
            }
          : null,
    }),
    defineTool({
      id: 'health_report',
      version: '1',
      category: 'health',
      description:
        "Valori di un'analisi con il confronto con quella precedente. Senza selezione restituisce solo l'ultima analisi con data nota. Per referti senza data usa reportId da health_overview: non vengono considerati recenti né confrontati nel tempo. L'app mostra la tabellina.",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({
        date: day
          .optional()
          .describe("Giorno dell'analisi (YYYY-MM-DD); senza selezione, l'ultima con data nota"),
        reportId: z
          .uuid()
          .optional()
          .describe(
            'Identificativo da health_overview, anche per referti senza data; alternativo a date.',
          ),
        against: day
          .optional()
          .describe("Giorno dell'analisi con cui confrontare; senza, la precedente"),
      }),
      outputSchema: z.object({
        found: z.boolean(),
        id: z.string().optional(),
        takenOn: z.string().nullable().optional(),
        reason: z.string().optional(),
        lab: z.string().nullable().optional(),
        kind: z.string().optional(),
        againstDate: z.string().nullable().optional(),
        rows: z.array(Row).optional(),
        summary: z.string().optional(),
        shown: z.string().optional(),
        caution: z.string(),
      }),
      execute: async (input, ctx) => {
        const r = await store.report(ctx.userId, {
          ...(input.date ? { date: input.date } : {}),
          ...(input.against ? { against: input.against } : {}),
          ...(input.reportId ? { reportId: input.reportId } : {}),
        });
        if (!r)
          return {
            found: false,
            reason:
              'Referto non trovato. Senza selezione vengono cercati solo referti con data nota; health_overview elenca anche quelli senza data.',
            caution: CAUTION,
          };
        return {
          found: true,
          id: r.id,
          takenOn: r.takenOn,
          lab: r.lab,
          kind: r.kind,
          againstDate: r.againstDate,
          rows: r.rows,
          summary: outOfRangeSummary(r.rows),
          shown: SHOWN,
          caution: CAUTION,
        };
      },
      present: (_i, out): ContentBlock | null =>
        out.found && out.rows?.length
          ? {
              kind: 'health',
              mode: 'report',
              title:
                `${(out.kind ?? 'analisi').replace(/^./, (c) => c.toUpperCase())}${out.takenOn ? ` del ${shortDate(out.takenOn)}` : ' · data non disponibile'}`.slice(
                  0,
                  120,
                ),
              subtitle: [
                out.lab,
                out.againstDate ? `confronto con il ${shortDate(out.againstDate)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')
                .slice(0, 160),
              rows: blockRows(out.rows),
              ...(out.summary ? { summary: out.summary } : {}),
            }
          : null,
    }),
    defineTool({
      id: 'health_overview',
      version: '1',
      category: 'health',
      description:
        "Cosa c'è nella sezione salute dell'utente: le analisi salvate (data, laboratorio, quanti valori, quanti fuori intervallo) e i parametri con il numero di misure.",
      risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
      timeoutMs: 15_000,
      inputSchema: z.object({}),
      outputSchema: z.object({
        reports: z.array(
          z.object({
            id: z.string(),
            takenOn: z.string().nullable(),
            lab: z.string().nullable(),
            kind: z.string(),
            values: z.number(),
            outOfRange: z.number(),
          }),
        ),
        parameters: z.array(z.object({ label: z.string(), count: z.number() })),
      }),
      execute: async (_i, ctx) => store.overview(ctx.userId),
    }),
    defineTool({
      id: 'health_import',
      version: '1',
      category: 'health',
      description:
        "Legge un documento già caricato come referto di analisi e ne salva i valori nella sezione salute (di solito avviene da solo al caricamento; usalo se l'utente chiede di aggiungere un referto che non risulta). Serve l'id del documento (document_list).",
      risk: { readsPrivate: true, ingestsUntrusted: true, externalEffect: false, write: true },
      timeoutMs: 150_000,
      inputSchema: z.object({ documentId: z.uuid() }),
      outputSchema: z.object({
        ok: z.boolean(),
        reason: z.string().optional(),
        takenOn: z.string().nullable().optional(),
        values: z.number().optional(),
        outOfRange: z.array(z.string()).optional(),
      }),
      untrustedSource: (i) => `document:${i.documentId}`,
      execute: async ({ documentId }, ctx) => store.importDocument(ctx.userId, documentId),
    }),
  ];
}
