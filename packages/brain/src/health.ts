import { type Pool, withUser } from '@ernie/db';
import { safeFileName } from './note.js';

/**
 * Sezione salute del second brain (richiesta dell'utente, 13 ott 2026): analisi del sangue e referti con i
 * valori strutturati, per confrontarli tra un'analisi e l'altra. Qui ci sono le parti deterministiche: nomi
 * dei parametri, numeri e intervalli all'italiana, fuori intervallo, andamenti, avvisi, archivio e note.
 * L'estrazione dal testo del referto la fa il modello (agent-core), con uno schema largo; qui si controlla.
 */

export type HealthFlag = 'alto' | 'basso' | 'normale' | 'n/d';

/** Riga estratta dal referto, ancora grezza (stringhe come scritte nel documento). */
export interface RawHealthItem {
  readonly name?: string | null | undefined;
  readonly value?: string | null | undefined;
  readonly unit?: string | null | undefined;
  readonly ref?: string | null | undefined;
  /** Sezione del referto: i valori delle urine sono serie diverse da quelli del sangue (glucosio, proteine). */
  readonly section?: 'sangue' | 'urine' | 'altro' | null | undefined;
}

export interface HealthValue {
  readonly parameter: string;
  readonly label: string;
  readonly value: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly refLow: number | null;
  readonly refHigh: number | null;
  readonly refText: string | null;
  readonly flag: HealthFlag;
}

// ---------- nomi dei parametri ----------

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .trim();

/** [chiave, etichetta, sinonimi] dei parametri più comuni nei referti italiani. */
const PARAMETERS: Array<[string, string, string[]]> = [
  ['emoglobina', 'Emoglobina', ['emoglobina', 'hb', 'hgb']],
  ['ematocrito', 'Ematocrito', ['ematocrito', 'hct']],
  ['globuli_rossi', 'Globuli rossi', ['globuli rossi', 'eritrociti', 'gr', 'rbc']],
  ['globuli_bianchi', 'Globuli bianchi', ['globuli bianchi', 'leucociti', 'gb', 'wbc']],
  ['piastrine', 'Piastrine', ['piastrine', 'plt', 'trombociti']],
  ['mcv', 'MCV', ['mcv', 'volume corpuscolare medio']],
  ['mch', 'MCH', ['mch', 'contenuto emoglobinico medio']],
  ['mchc', 'MCHC', ['mchc', 'concentrazione emoglobinica media']],
  ['neutrofili', 'Neutrofili', ['neutrofili']],
  ['linfociti', 'Linfociti', ['linfociti']],
  ['monociti', 'Monociti', ['monociti']],
  ['eosinofili', 'Eosinofili', ['eosinofili']],
  ['basofili', 'Basofili', ['basofili']],
  ['glicemia', 'Glicemia', ['glicemia', 'glucosio', 'glucosio a digiuno']],
  [
    'emoglobina_glicata',
    'Emoglobina glicata',
    ['emoglobina glicata', 'hba1c', 'hb a1c', 'glicata'],
  ],
  ['colesterolo_totale', 'Colesterolo totale', ['colesterolo totale', 'colesterolo']],
  ['colesterolo_hdl', 'Colesterolo HDL', ['colesterolo hdl', 'hdl', 'hdl colesterolo']],
  ['colesterolo_ldl', 'Colesterolo LDL', ['colesterolo ldl', 'ldl', 'ldl colesterolo']],
  ['colesterolo_non_hdl', 'Colesterolo non HDL', ['colesterolo non hdl', 'non hdl']],
  ['trigliceridi', 'Trigliceridi', ['trigliceridi']],
  ['creatinina', 'Creatinina', ['creatinina', 'creatininemia']],
  ['egfr', 'eGFR', ['egfr', 'filtrato glomerulare', 'velocita di filtrazione glomerulare']],
  ['azotemia', 'Azotemia', ['azotemia', 'urea']],
  ['acido_urico', 'Acido urico', ['acido urico', 'uricemia']],
  ['ast', 'AST (GOT)', ['ast', 'got', 'ast got', 'got ast', 'aspartato aminotransferasi']],
  ['alt', 'ALT (GPT)', ['alt', 'gpt', 'alt gpt', 'gpt alt', 'alanina aminotransferasi']],
  ['gamma_gt', 'Gamma GT', ['gamma gt', 'ggt', 'gamma glutamiltransferasi', 'γgt']],
  ['fosfatasi_alcalina', 'Fosfatasi alcalina', ['fosfatasi alcalina', 'alp']],
  ['bilirubina_totale', 'Bilirubina totale', ['bilirubina totale', 'bilirubina']],
  ['bilirubina_diretta', 'Bilirubina diretta', ['bilirubina diretta', 'bilirubina coniugata']],
  [
    'bilirubina_indiretta',
    'Bilirubina indiretta',
    ['bilirubina indiretta', 'bilirubina non coniugata'],
  ],
  ['sodio', 'Sodio', ['sodio', 'na', 'sodiemia']],
  ['potassio', 'Potassio', ['potassio', 'k', 'potassiemia']],
  ['calcio', 'Calcio', ['calcio', 'ca', 'calcemia']],
  ['magnesio', 'Magnesio', ['magnesio', 'mg', 'magnesiemia']],
  ['ferro', 'Ferro', ['ferro', 'sideremia', 'fe']],
  ['ferritina', 'Ferritina', ['ferritina']],
  ['transferrina', 'Transferrina', ['transferrina']],
  ['tsh', 'TSH', ['tsh', 'tireotropina']],
  ['ft3', 'FT3', ['ft3', 'triiodotironina libera']],
  ['ft4', 'FT4', ['ft4', 'tiroxina libera']],
  [
    'vitamina_d',
    'Vitamina D',
    ['vitamina d', '25 oh vitamina d', '25 idrossivitamina d', 'vitamina d 25 oh', 'vit d'],
  ],
  ['vitamina_b12', 'Vitamina B12', ['vitamina b12', 'cobalamina', 'vit b12']],
  ['acido_folico', 'Acido folico', ['acido folico', 'folati', 'folato']],
  ['pcr', 'PCR', ['pcr', 'proteina c reattiva', 'proteina c reattiva hs']],
  ['ves', 'VES', ['ves', 'velocita di eritrosedimentazione']],
  ['psa', 'PSA', ['psa', 'psa totale']],
  ['albumina', 'Albumina', ['albumina']],
  ['proteine_totali', 'Proteine totali', ['proteine totali', 'protidemia']],
  ['inr', 'INR', ['inr']],
  ['peso_specifico', 'Peso specifico', ['peso specifico']],
  ['proteine', 'Proteine', ['proteine', 'proteinuria']],
];

const SYNONYMS = new Map<string, [string, string]>();
for (const [key, label, syns] of PARAMETERS)
  for (const s of syns) SYNONYMS.set(fold(s), [key, label]);

/** Nome del parametro nel referto → chiave stabile ed etichetta («GOT» e «AST» sono lo stesso). */
export function canonicalParameter(name: string): { key: string; label: string } {
  const f = fold(name);
  const exact = SYNONYMS.get(f);
  if (exact) return { key: exact[0], label: exact[1] };
  // Nomi lunghi del laboratorio: «COLESTEROLO HDL (metodo diretto)», «S-Creatinina».
  for (const [syn, [key, label]] of [...SYNONYMS.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  ))
    if (syn.length >= 3 && (` ${f} `.includes(` ${syn} `) || f.endsWith(` ${syn}`)))
      return { key, label };
  const slug = f.replace(/\s+/g, '_').slice(0, 60) || 'parametro';
  let label = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  // «OMOCISTEINA» → «Omocisteina» (le sigle corte restano maiuscole).
  if (label.length > 5 && label === label.toUpperCase()) label = label.toLowerCase();
  return { key: slug, label: label.charAt(0).toUpperCase() + label.slice(1) };
}

// ---------- numeri e intervalli ----------

/** «5,4» → 5.4; «1.234,5» → 1234.5; «12.5» → 12.5 (un solo punto è decimale: peso specifico 1.020); altrimenti null. */
export function parseNumber(v: string | null | undefined): number | null {
  const t = (v ?? '').trim().replace(/\s/g, '');
  if (!/^[+-]?\d[\d.,]*$/.test(t)) return null;
  let s = t;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Intervallo di riferimento: «70 - 110», «0,5-1,2», «< 200», «> 40», «fino a 35». */
export function parseRange(v: string | null | undefined): {
  low: number | null;
  high: number | null;
} {
  const t = (v ?? '').replace(/–|—/g, '-').toLowerCase();
  const num = '([+-]?\\d[\\d.,]*)';
  const between = new RegExp(`${num}\\s*(?:-|a)\\s*${num}`).exec(t);
  if (between) return { low: parseNumber(between[1]), high: parseNumber(between[2]) };
  const below = new RegExp(`(?:<|≤|<=|inferiore a|fino a|minore di)\\s*${num}`).exec(t);
  if (below) return { low: null, high: parseNumber(below[1]) };
  const above = new RegExp(`(?:>|≥|>=|superiore a|maggiore di)\\s*${num}`).exec(t);
  if (above) return { low: parseNumber(above[1]), high: null };
  return { low: null, high: null };
}

export function flagFor(value: number | null, low: number | null, high: number | null): HealthFlag {
  if (value === null || (low === null && high === null)) return 'n/d';
  if (high !== null && value > high) return 'alto';
  if (low !== null && value < low) return 'basso';
  return 'normale';
}

const cleanUnit = (u: string | null | undefined) => {
  const t = (u ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 30) : null;
};

/** «< 41» esclude il 41 (e «> 40» il 40): al limite esatto il valore è fuori. «≤» e «fino a» lo includono. */
function strictFlag(
  flag: HealthFlag,
  value: number | null,
  low: number | null,
  high: number | null,
  ref: string | null | undefined,
): HealthFlag {
  const t = (ref ?? '').trim();
  if (flag === 'normale' && value !== null && high !== null && value === high && /^<(?!=)/.test(t))
    return 'alto';
  if (flag === 'normale' && value !== null && low !== null && value === low && /^>(?!=)/.test(t))
    return 'basso';
  return flag;
}

const LEUKO = new Set(['neutrofili', 'linfociti', 'monociti', 'eosinofili', 'basofili']);

/** Riga grezza → valore controllato; null se manca il nome o il valore. */
export function toHealthValue(raw: RawHealthItem): HealthValue | null {
  const name = (raw.name ?? '').trim();
  const valueRaw = (raw.value ?? '').trim();
  if (!name || !valueRaw || name.length > 120) return null;
  const canon = canonicalParameter(name);
  // Formula leucocitaria: la percentuale e il valore assoluto sono due serie diverse.
  const pct = (raw.unit ?? '').trim() === '%' && LEUKO.has(canon.key);
  const urine = raw.section === 'urine';
  const key = `${urine ? 'urine_' : ''}${pct ? `${canon.key}_perc` : canon.key}`;
  const base = urine && canon.key === 'glicemia' ? 'Glucosio' : canon.label;
  const label = `${pct ? `${base} %` : base}${urine ? ' (urine)' : ''}`;
  const value = parseNumber(valueRaw);
  const { low, high } = parseRange(raw.ref);
  return {
    parameter: key,
    label,
    value,
    valueText: value === null ? valueRaw.slice(0, 60) : null,
    unit: cleanUnit(raw.unit),
    refLow: low,
    refHigh: high,
    refText: (raw.ref ?? '').trim().slice(0, 60) || null,
    flag: strictFlag(flagFor(value, low, high), value, low, high, raw.ref),
  };
}

/** Un referto da laboratorio: molte righe con unità di misura tipiche e le parole dei referti. */
export function looksLikeLabReport(text: string): boolean {
  const t = text.toLowerCase();
  const units =
    t.match(
      /\b(?:mg\/dl|g\/dl|u\/l|ui\/l|mmol\/l|µmol\/l|umol\/l|ng\/ml|pg\/ml|µui\/ml|mui\/l|mu\/l|fl|10\^?\d\/[uµ]l|x10\^?\d|mm\/h|mg\/l|nmol\/l|meq\/l)\b/g,
    )?.length ?? 0;
  const words =
    /valori di riferimento|intervallo di riferimento|range di riferimento|esami ematochimici|emocromo|referto|laboratorio analisi/.test(
      t,
    );
  return units >= 6 && words;
}

// ---------- andamenti e avvisi ----------

export interface SeriesPoint {
  readonly date: string;
  readonly value: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly flag: HealthFlag;
  readonly refLow: number | null;
  readonly refHigh: number | null;
}

/** Andamento tra le ultime due misure con la stessa unità: «su», «giù», «stabile» (entro il 3 %). */
export function trendOf(points: readonly SeriesPoint[]): 'su' | 'giu' | 'stabile' | null {
  const nums = points.filter((p) => p.value !== null);
  const last = nums.at(-1);
  const prev = nums.at(-2);
  if (!last || !prev || last.value === null || prev.value === null || last.unit !== prev.unit)
    return null;
  const delta = last.value - prev.value;
  if (Math.abs(delta) <= Math.abs(prev.value) * 0.03) return 'stabile';
  return delta > 0 ? 'su' : 'giu';
}

const fmt = (n: number) => n.toLocaleString('it-IT', { maximumFractionDigits: 2 });

/**
 * Avvisi dopo un nuovo referto (decisione dell'utente: Ernie li dice di sua iniziativa, una volta):
 * valori fuori intervallo e valori che peggiorano da almeno tre misure di fila (allontanandosi dall'intervallo).
 */
export function healthNotices(
  current: readonly HealthValue[],
  history: ReadonlyMap<string, readonly SeriesPoint[]>,
): string[] {
  const out: string[] = [];
  for (const v of current) {
    if (v.value === null) continue;
    const pts = (history.get(v.parameter) ?? []).filter(
      (p) => p.value !== null && p.unit === v.unit,
    );
    const before = pts.slice(-3, -1).map((p) => p.value as number);
    const unit = v.unit ? ` ${v.unit}` : '';
    const prevText = before.length ? `, prima ${before.map(fmt).reverse().join(' e ')}` : '';
    if (v.flag === 'alto' || v.flag === 'basso') {
      const ref = v.refText ? ` (riferimento ${v.refText})` : '';
      out.push(`${v.label} ${fmt(v.value)}${unit}: ${v.flag}${ref}${prevText}.`);
      continue;
    }
    // Peggioramento continuo verso il limite, anche se ancora nell'intervallo.
    const series = [...pts.slice(-3).map((p) => p.value as number)];
    if (series.length >= 3) {
      const [a, b, c] = series.slice(-3) as [number, number, number];
      const up = a < b && b < c && v.refHigh !== null && c > v.refHigh * 0.9;
      const down = a > b && b > c && v.refLow !== null && c < v.refLow * 1.1;
      if (up || down)
        out.push(
          `${v.label} ${up ? 'sale' : 'scende'} da tre analisi di fila (${[a, b, c].map(fmt).join(' → ')}${unit}), vicino al limite.`,
        );
    }
  }
  return out.slice(0, 8);
}

// ---------- note per il vault ----------

const arrow: Record<HealthFlag, string> = { alto: '⬆️', basso: '⬇️', normale: '', 'n/d': '' };

/** «2026-10-13» → «13 ottobre 2026». */
export const italianDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const months = [
    'gennaio',
    'febbraio',
    'marzo',
    'aprile',
    'maggio',
    'giugno',
    'luglio',
    'agosto',
    'settembre',
    'ottobre',
    'novembre',
    'dicembre',
  ];
  return `${d} ${months[(m ?? 1) - 1]} ${y}`;
};

/** Corpo della nota di un referto: tabella con i fuori intervallo segnati e il rimando ai parametri. */
export function reportNoteBody(
  r: { takenOn: string; lab: string | null; kind: string },
  values: readonly HealthValue[],
): string {
  const rows = values.map((v) => {
    const val = v.value !== null ? fmt(v.value) : (v.valueText ?? '');
    return `| [[${v.label}]] | ${val} ${arrow[v.flag]} | ${v.unit ?? ''} | ${v.refText ?? ''} |`;
  });
  const out = values.filter((v) => v.flag === 'alto' || v.flag === 'basso');
  return [
    `# ${r.kind.charAt(0).toUpperCase()}${r.kind.slice(1)} del ${italianDay(r.takenOn)}`,
    '',
    r.lab ? `Laboratorio: ${r.lab}` : '',
    out.length
      ? `Fuori intervallo: ${out.map((v) => v.label).join(', ')}.`
      : 'Tutti i valori con riferimento sono nell’intervallo.',
    '',
    '| Parametro | Valore | Unità | Riferimento |',
    '|---|---|---|---|',
    ...rows,
    '',
    '_Valori letti dal referto da Ernie: in caso di dubbio fa fede il documento originale. Parlane con il tuo medico._',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

/** Corpo della pagina di un parametro: storico in tabella dal più recente. */
export function parameterNoteBody(label: string, points: readonly SeriesPoint[]): string {
  const rows = [...points].reverse().map((p) => {
    const val = p.value !== null ? fmt(p.value) : (p.valueText ?? '');
    const ref =
      p.refLow !== null || p.refHigh !== null
        ? `${p.refLow !== null ? fmt(p.refLow) : ''}–${p.refHigh !== null ? fmt(p.refHigh) : ''}`
        : '';
    return `| ${italianDay(p.date)} | ${val} ${arrow[p.flag]} | ${p.unit ?? ''} | ${ref} |`;
  });
  const t = trendOf(points);
  return [
    `# ${label}`,
    '',
    t
      ? `Ultimo andamento: ${t === 'su' ? 'in salita' : t === 'giu' ? 'in discesa' : 'stabile'}.`
      : '',
    '',
    '| Data | Valore | Unità | Riferimento |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Parte della sezione [[Salute]].',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

/** Cartella riservata della sezione nel vault. */
export const HEALTH_FOLDER = 'Salute';
export const healthReportTitle = (r: { takenOn: string; kind: string }) =>
  `${r.kind.charAt(0).toUpperCase()}${r.kind.slice(1)} del ${italianDay(r.takenOn)}`;
export const healthReportPath = (title: string) =>
  `${HEALTH_FOLDER}/Analisi/${safeFileName(title)}.md`;
export const healthParameterPath = (label: string) =>
  `${HEALTH_FOLDER}/Parametri/${safeFileName(label)}.md`;
export const HEALTH_INDEX_PATH = `${HEALTH_FOLDER}/Salute.md`;

/** Pagina indice della sezione: analisi dalla più recente e parametri con il numero di misure. */
export function healthIndexBody(
  reports: ReadonlyArray<{ title: string; outOfRange: number; values: number }>,
  parameters: ReadonlyArray<{ label: string; count: number }>,
): string {
  return [
    '# Salute',
    '',
    'Sezione riservata: analisi ed esami letti da Ernie dai referti caricati, con lo storico di ogni parametro.',
    '',
    '## Analisi',
    '',
    ...(reports.length
      ? reports.map(
          (r) =>
            `- [[${r.title}]] · ${r.values} valori${r.outOfRange ? `, ${r.outOfRange} fuori intervallo` : ''}`,
        )
      : ['- Nessuna analisi ancora.']),
    '',
    '## Parametri',
    '',
    ...(parameters.length
      ? parameters.map(
          (p) => `- [[${p.label}]] (${p.count === 1 ? '1 misura' : `${p.count} misure`})`,
        )
      : ['- Nessun parametro ancora.']),
    '',
    '_Pagine generate da Ernie e riscritte a ogni nuovo referto: le modifiche fatte qui si perdono. In caso di dubbio fa fede il referto originale._',
  ].join('\n');
}

// ---------- archivio ----------

export interface HealthReportSummary {
  readonly id: string;
  readonly takenOn: string;
  readonly lab: string | null;
  readonly kind: string;
  readonly notePath: string | null;
  readonly values: number;
  readonly outOfRange: number;
}

export interface HealthStore {
  saveReport(
    userId: string,
    r: { takenOn: string; lab: string | null; kind: string; documentId?: string | null },
    values: readonly HealthValue[],
  ): Promise<string | null>;
  setNotePath(userId: string, reportId: string, path: string): Promise<void>;
  reports(userId: string, limit?: number): Promise<HealthReportSummary[]>;
  reportValues(userId: string, reportId: string): Promise<HealthValue[]>;
  /** Storico di un parametro (per chiave), dal più vecchio. */
  series(userId: string, parameter: string): Promise<SeriesPoint[]>;
  /** Parametri noti con etichetta e numero di misure. */
  parameters(userId: string): Promise<Array<{ parameter: string; label: string; count: number }>>;
  /** Avvisi da dire; `reportId` null per i riepiloghi, che non vengono mai superati. */
  addNotices(userId: string, reportId: string | null, texts: readonly string[]): Promise<void>;
  /** Un referto più recente rende superati gli avvisi non ancora detti dei referti precedenti. */
  supersedeNotices(userId: string, keepReportId: string): Promise<void>;
  pendingNotices(userId: string): Promise<Array<{ id: string; text: string }>>;
  markNotified(userId: string, ids: readonly string[]): Promise<void>;
  hasDocument(userId: string, documentId: string): Promise<boolean>;
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function createHealthStore(pool: Pool): HealthStore {
  return {
    async saveReport(userId, r, values) {
      return withUser(pool, userId, async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO health_reports (user_id, taken_on, lab, kind, document_id) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, document_id) WHERE document_id IS NOT NULL DO NOTHING RETURNING id`,
          [userId, r.takenOn, r.lab, r.kind, r.documentId ?? null],
        );
        const id = ins.rows[0]?.id;
        if (!id) return null;
        for (const v of values)
          await c.query(
            `INSERT INTO health_values (user_id, report_id, parameter, label, value, value_text, unit, ref_low, ref_high, ref_text, flag)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              userId,
              id,
              v.parameter,
              v.label,
              v.value,
              v.valueText,
              v.unit,
              v.refLow,
              v.refHigh,
              v.refText,
              v.flag,
            ],
          );
        return id;
      });
    },
    async setNotePath(userId, reportId, path) {
      await withUser(pool, userId, (c) =>
        c.query(`UPDATE health_reports SET note_path = $2 WHERE id = $1`, [reportId, path]),
      );
    },
    async reports(userId, limit = 20) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{
          id: string;
          taken_on: string;
          lab: string | null;
          kind: string;
          note_path: string | null;
          values: string;
          out: string;
        }>(
          `SELECT r.id, to_char(r.taken_on,'YYYY-MM-DD') AS taken_on, r.lab, r.kind, r.note_path,
                  count(v.id)::text AS values, count(v.id) FILTER (WHERE v.flag IN ('alto','basso'))::text AS out
             FROM health_reports r LEFT JOIN health_values v ON v.report_id = r.id
            GROUP BY r.id ORDER BY r.taken_on DESC, r.created_at DESC LIMIT $1`,
          [limit],
        );
        return r.rows.map((x) => ({
          id: x.id,
          takenOn: x.taken_on,
          lab: x.lab,
          kind: x.kind,
          notePath: x.note_path,
          values: Number(x.values),
          outOfRange: Number(x.out),
        }));
      });
    },
    async reportValues(userId, reportId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Record<string, unknown>>(
          `SELECT parameter, label, value, value_text, unit, ref_low, ref_high, ref_text, flag FROM health_values
            WHERE report_id = $1 ORDER BY label`,
          [reportId],
        );
        return r.rows.map((x) => ({
          parameter: String(x.parameter),
          label: String(x.label),
          value: numOrNull(x.value),
          valueText: (x.value_text as string | null) ?? null,
          unit: (x.unit as string | null) ?? null,
          refLow: numOrNull(x.ref_low),
          refHigh: numOrNull(x.ref_high),
          refText: (x.ref_text as string | null) ?? null,
          flag: x.flag as HealthFlag,
        }));
      });
    },
    async series(userId, parameter) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Record<string, unknown>>(
          `SELECT to_char(r.taken_on,'YYYY-MM-DD') AS date, v.value, v.value_text, v.unit, v.flag, v.ref_low, v.ref_high
             FROM health_values v JOIN health_reports r ON r.id = v.report_id
            WHERE v.parameter = $1 ORDER BY r.taken_on, r.created_at`,
          [parameter],
        );
        return r.rows.map((x) => ({
          date: String(x.date),
          value: numOrNull(x.value),
          valueText: (x.value_text as string | null) ?? null,
          unit: (x.unit as string | null) ?? null,
          flag: x.flag as HealthFlag,
          refLow: numOrNull(x.ref_low),
          refHigh: numOrNull(x.ref_high),
        }));
      });
    },
    async parameters(userId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ parameter: string; label: string; count: string }>(
          `SELECT parameter, max(label) AS label, count(*)::text AS count FROM health_values
            GROUP BY parameter ORDER BY max(label)`,
        );
        return r.rows.map((x) => ({
          parameter: x.parameter,
          label: x.label,
          count: Number(x.count),
        }));
      });
    },
    async addNotices(userId, reportId, texts) {
      if (!texts.length) return;
      await withUser(pool, userId, async (c) => {
        for (const t of texts)
          await c.query(`INSERT INTO health_notices (user_id, report_id, text) VALUES ($1,$2,$3)`, [
            userId,
            reportId,
            t,
          ]);
      });
    },
    async supersedeNotices(userId, keepReportId) {
      await withUser(pool, userId, (c) =>
        c.query(
          `UPDATE health_notices SET notified_at = now()
            WHERE notified_at IS NULL AND report_id IS NOT NULL AND report_id <> $1`,
          [keepReportId],
        ),
      );
    },
    async pendingNotices(userId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ id: string; text: string }>(
          `SELECT id::text, text FROM health_notices WHERE notified_at IS NULL ORDER BY created_at, id LIMIT 20`,
        );
        return r.rows;
      });
    },
    async markNotified(userId, ids) {
      if (!ids.length) return;
      await withUser(pool, userId, (c) =>
        c.query(`UPDATE health_notices SET notified_at = now() WHERE id = ANY($1::bigint[])`, [
          ids,
        ]),
      );
    },
    async hasDocument(userId, documentId) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query(`SELECT 1 FROM health_reports WHERE document_id = $1`, [
          documentId,
        ]);
        return (r.rowCount ?? 0) > 0;
      });
    },
  };
}
