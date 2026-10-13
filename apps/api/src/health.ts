import type { HealthExtractor } from '@ernie/agent-core';
import {
  type BrainService,
  canonicalParameter,
  createHealthStore,
  HEALTH_INDEX_PATH,
  type HealthValue,
  healthIndexBody,
  healthNotices,
  healthParameterPath,
  healthReportPath,
  healthReportTitle,
  isoDay,
  italianDay,
  looksLikeLabReport,
  parameterNoteBody,
  reportNoteBody,
  type SeriesPoint,
  titleFromPath,
  toHealthValue,
  trendOf,
} from '@ernie/brain';
import type { Pool } from '@ernie/db';
import type { DocumentRepository } from '@ernie/documents';
import type { Logger } from '@ernie/observability';
import type { HealthToolRow, HealthToolStore } from '@ernie/tools';

/**
 * Sezione salute (13 ott 2026). Decisioni dell'utente: i valori si leggono ogni volta che carica un referto;
 * l'archivio sta anche in Obsidian (cartella «Salute», note riservate); confronti e andamenti con la
 * tabellina; spiegazioni prudenti; avvisi detti di iniziativa una volta, al turno successivo.
 */
export interface HealthRuntimeDeps {
  readonly pool: Pool;
  readonly extractor: HealthExtractor | null;
  readonly brain: BrainService | null;
  readonly documents: DocumentRepository;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

export interface HealthRuntime {
  readonly tools: HealthToolStore;
  /** Dopo il caricamento di un documento: se sembra un referto, legge e salva i valori (in background). */
  onDocumentCreated(
    userId: string,
    documentId: string,
    title: string,
    pages: readonly string[],
  ): void;
  /** Avvisi ancora da dire, come blocco di contesto del turno; segnati come detti. */
  takeNotices(userId: string): Promise<string | null>;
}

type ImportResult = Awaited<ReturnType<HealthToolStore['importDocument']>>;

const todayRome = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

const pctTrend = (prev: number, cur: number): 'su' | 'giu' | 'stabile' => {
  const delta = cur - prev;
  if (Math.abs(delta) <= Math.abs(prev) * 0.03) return 'stabile';
  return delta > 0 ? 'su' : 'giu';
};

/** Un parametro per chiave e unità: se il referto lo ripete, vale la prima riga. */
export function dedupeValues(values: readonly HealthValue[]): HealthValue[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = `${v.parameter}|${v.unit ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function createHealthRuntime(deps: HealthRuntimeDeps): HealthRuntime {
  const store = createHealthStore(deps.pool);
  const running = new Set<string>();

  /** Note del vault: referto, pagine dei parametri toccati e indice della sezione. */
  const writeNotes = async (userId: string, reportId: string, values: readonly HealthValue[]) => {
    if (!deps.brain) return;
    const reports = await store.reports(userId, 200);
    const r = reports.find((x) => x.id === reportId);
    if (!r) return;
    let title = healthReportTitle(r);
    const sameDay = reports.filter(
      (x) => x.id !== reportId && x.notePath === healthReportPath(title),
    );
    if (sameDay.length) title = `${title} (${r.lab ?? sameDay.length + 1})`;
    const path = healthReportPath(title);
    const notes: Parameters<BrainService['writeGenerated']>[1][number][] = [
      {
        path,
        title,
        type: 'salute',
        body: reportNoteBody(r, values),
        links: ['Salute'],
        refersFrom: r.takenOn,
        source: 'pdf',
      },
    ];
    for (const v of values) {
      const series = await store.series(userId, v.parameter);
      notes.push({
        path: healthParameterPath(v.label),
        title: v.label,
        type: 'salute',
        body: parameterNoteBody(v.label, series),
        links: ['Salute'],
      });
    }
    const titles = reports.map((x) =>
      x.id === reportId ? title : x.notePath ? titleFromPath(x.notePath) : healthReportTitle(x),
    );
    notes.push({
      path: HEALTH_INDEX_PATH,
      title: 'Salute',
      type: 'salute',
      body: healthIndexBody(
        reports.map((x, i) => ({
          title: titles[i] ?? healthReportTitle(x),
          values: x.values,
          outOfRange: x.outOfRange,
        })),
        await store.parameters(userId),
      ),
    });
    await deps.brain.writeGenerated(
      userId,
      notes,
      `Ernie: salute, «${title}» (${values.length} valori)`,
    );
    await store.setNotePath(userId, reportId, path);
  };

  const ingest = async (
    userId: string,
    documentId: string,
    title: string,
    pages: readonly string[],
    force: boolean,
  ): Promise<ImportResult> => {
    const text = pages.join('\n\n');
    if (!force && !looksLikeLabReport(text))
      return { ok: false, reason: 'non sembra un referto di analisi' };
    if (await store.hasDocument(userId, documentId))
      return { ok: false, reason: 'questo referto è già nella sezione salute' };
    if (!deps.extractor) return { ok: false, reason: 'lettura dei referti non disponibile' };
    const key = `${userId}:${documentId}`;
    if (running.has(key)) return { ok: false, reason: 'lettura già in corso' };
    running.add(key);
    try {
      const ex = await deps.extractor(text, { userId, documentTitle: title });
      if (!ex?.isLabReport)
        return { ok: false, reason: 'nel documento non ho trovato valori di analisi' };
      const values = dedupeValues(
        ex.items.map(toHealthValue).filter((v): v is HealthValue => v !== null),
      );
      if (!values.length)
        return { ok: false, reason: 'nel documento non ho trovato valori di analisi' };
      const takenOn = isoDay(ex.takenOn) ?? todayRome();
      const kind = (ex.kind?.trim().toLowerCase() || 'analisi del sangue').slice(0, 60);
      const lab = ex.lab?.trim().slice(0, 120) || null;
      const reportId = await store.saveReport(userId, { takenOn, lab, kind, documentId }, values);
      if (!reportId) return { ok: false, reason: 'questo referto è già nella sezione salute' };
      const out = values.filter((v) => v.flag === 'alto' || v.flag === 'basso');
      // Avvisi: il riepilogo sempre; fuori intervallo e peggioramenti solo se è l'analisi più recente.
      const reports = await store.reports(userId, 200);
      const latest = reports.every((r) => r.takenOn <= takenOn);
      const history = new Map<string, SeriesPoint[]>();
      if (latest)
        for (const v of values) history.set(v.parameter, await store.series(userId, v.parameter));
      const summary = `Ho letto il referto «${title.slice(0, 80)}» (${kind} del ${italianDay(takenOn)}): ${values.length} valori salvati nella sezione Salute${out.length ? `, ${out.length} fuori intervallo` : ', tutti nell’intervallo'}.`;
      await store.addNotices(userId, reportId, [
        summary,
        ...(latest ? healthNotices(values, history) : []),
      ]);
      await writeNotes(userId, reportId, values).catch((err: unknown) =>
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err), reportId },
          'salute: note del vault non scritte',
        ),
      );
      deps.logger.info(
        { userId, reportId, values: values.length, out: out.length },
        'salute: referto letto',
      );
      return { ok: true, takenOn, values: values.length, outOfRange: out.map((v) => v.label) };
    } finally {
      running.delete(key);
    }
  };

  const rowsOfSeries = (points: readonly SeriesPoint[], label: string): HealthToolRow[] =>
    points.map((p) => ({
      label,
      date: p.date,
      value: p.value,
      valueText: p.valueText,
      unit: p.unit,
      refLow: p.refLow,
      refHigh: p.refHigh,
      refText: null,
      flag: p.flag,
    }));

  const tools: HealthToolStore = {
    async overview(userId) {
      const [reports, parameters] = await Promise.all([
        store.reports(userId, 50),
        store.parameters(userId),
      ]);
      return {
        reports: reports.map((r) => ({
          takenOn: r.takenOn,
          lab: r.lab,
          kind: r.kind,
          values: r.values,
          outOfRange: r.outOfRange,
        })),
        parameters: parameters.map((p) => ({ label: p.label, count: p.count })),
      };
    },

    async parameter(userId, name) {
      const known = await store.parameters(userId);
      const canon = canonicalParameter(name).key;
      const f = fold(name);
      const hit =
        known.find((p) => p.parameter === canon) ??
        known.find((p) => fold(p.label) === f) ??
        known.find((p) => fold(p.label).includes(f) || f.includes(fold(p.label)));
      if (!hit) return null;
      const points = await store.series(userId, hit.parameter);
      if (!points.length) return null;
      return { label: hit.label, rows: rowsOfSeries(points, hit.label), trend: trendOf(points) };
    },

    async report(userId, q) {
      const reports = await store.reports(userId, 200);
      if (!reports.length) return null;
      const idx = q.date ? reports.findIndex((r) => r.takenOn === q.date) : 0;
      const cur = reports[idx];
      if (!cur) return null;
      const against = q.against
        ? reports.find((r) => r.takenOn === q.against && r.id !== cur.id)
        : reports.slice(idx + 1).find((r) => r.takenOn < cur.takenOn);
      const values = await store.reportValues(userId, cur.id);
      const prev = against ? await store.reportValues(userId, against.id) : [];
      const prevBy = new Map(prev.map((v) => [`${v.parameter}|${v.unit ?? ''}`, v]));
      const rows: HealthToolRow[] = values.map((v) => {
        const p = prevBy.get(`${v.parameter}|${v.unit ?? ''}`);
        const withPrev = p?.value != null && v.value !== null && against;
        return {
          label: v.label,
          value: v.value,
          valueText: v.valueText,
          unit: v.unit,
          refLow: v.refLow,
          refHigh: v.refHigh,
          refText: v.refText,
          flag: v.flag,
          ...(withPrev && p?.value != null && v.value !== null
            ? {
                previous: { value: p.value, date: against.takenOn },
                trend: pctTrend(p.value, v.value),
              }
            : {}),
        };
      });
      return {
        takenOn: cur.takenOn,
        lab: cur.lab,
        kind: cur.kind,
        againstDate: against?.takenOn ?? null,
        rows,
      };
    },

    async importDocument(userId, documentId) {
      const doc = await deps.documents.get(userId, documentId);
      if (!doc) return { ok: false, reason: 'documento non trovato' };
      return ingest(userId, documentId, doc.title, doc.pageTexts, true);
    },
  };

  return {
    tools,
    onDocumentCreated(userId, documentId, title, pages) {
      if (!looksLikeLabReport(pages.join('\n\n'))) return;
      void ingest(userId, documentId, title, pages, false).catch((err: unknown) =>
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err), documentId },
          'salute: lettura del referto fallita',
        ),
      );
    },
    async takeNotices(userId) {
      const pending = await store.pendingNotices(userId);
      if (!pending.length) return null;
      await store.markNotified(
        userId,
        pending.map((n) => n.id),
      );
      return `Avvisi della sezione salute da dire all'utente di tua iniziativa, una volta, con calma e in poche parole (niente diagnosi; per i valori fuori intervallo suggerisci di parlarne con il medico; può chiederti la tabellina):\n${pending
        .map((n) => `- ${n.text}`)
        .join('\n')}`;
    },
  };
}
