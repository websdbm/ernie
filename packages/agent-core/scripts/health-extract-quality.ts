/**
 * Misura della lettura dei referti (sezione salute, 13 ott 2026): un referto inventato ma realistico, con le
 * insidie tipiche (virgole decimali, «<», formula leucocitaria in % e assoluta, urine, note e metodi da
 * saltare), confrontato con i valori attesi. Stampa precisione, richiamo e costo.
 * Uso: node --env-file=.env --import tsx --conditions=development packages/agent-core/scripts/health-extract-quality.ts
 */
import { loadConfig } from '@ernie/config';
import {
  buildProfiles,
  callCostUsd,
  createModelGateway,
  type LlmCallRecorder,
} from '@ernie/model-gateway';
import { createHealthExtractor } from '../src/health-extract.js';

const REFERTO = `LABORATORIO ANALISI CLINICHE SAN MARCO - Via Roma 12, Padova
Paziente: MARIO ESEMPIO   Nato il: 01/01/1970   Sesso: M
Data accettazione: 07/10/2026   Data referto: 08/10/2026   Richiesta n. 2026/88231

ESAMI EMATOCHIMICI                     RISULTATO    U.M.        VALORI DI RIFERIMENTO
GLUCOSIO                               104          mg/dL       70 - 100
  Metodo: esochinasi
EMOGLOBINA GLICATA (HbA1c)             38           mmol/mol    20 - 42
CREATININA                             0,98         mg/dL       0,70 - 1,20
eGFR (CKD-EPI)                         88           mL/min      > 60
COLESTEROLO TOTALE                     231          mg/dL       < 200
COLESTEROLO HDL                        48           mg/dL       > 40
COLESTEROLO LDL (calcolato)            158          mg/dL       < 115
TRIGLICERIDI                           125          mg/dL       < 150
AST (GOT)                              24           U/L         < 40
ALT (GPT)                              41           U/L         < 41
GAMMA GT                               35           U/L         8 - 61
FERRITINA                              145          ng/mL       30 - 400
TSH REFLEX                             2,15         µUI/mL      0,27 - 4,20
VITAMINA D (25-OH)                     18,4         ng/mL       30 - 100
  Nota: carenza < 20 ng/mL; insufficienza 20 - 30 ng/mL

EMOCROMO
GLOBULI BIANCHI                        6,8          10^3/µL     4,0 - 10,0
GLOBULI ROSSI                          5,02         10^6/µL     4,50 - 5,90
EMOGLOBINA                             15,1         g/dL        13,5 - 17,5
EMATOCRITO                             44,6         %           40,0 - 52,0
PIASTRINE                              231          10^3/µL     150 - 400
NEUTROFILI                             58,1         %           40,0 - 75,0
NEUTROFILI                             3,95         10^3/µL     1,80 - 7,50
LINFOCITI                              31,2         %           20,0 - 45,0
LINFOCITI                              2,12         10^3/µL     1,00 - 4,00

ESAME DELLE URINE
PESO SPECIFICO                         1.020                    1.005 - 1.030
GLUCOSIO                               assente                  assente
PROTEINE                               assenti                  assenti

Il presente referto è firmato digitalmente. Dott. Esempio, Direttore del laboratorio.`;

/** Attesi: nome di controllo (minuscolo, contenuto nel nome estratto) → valore come scritto. */
const EXPECTED: Array<[string, string, 'sangue' | 'urine']> = [
  ['glucosio', '104', 'sangue'],
  ['hba1c', '38', 'sangue'],
  ['creatinina', '0,98', 'sangue'],
  ['egfr', '88', 'sangue'],
  ['colesterolo totale', '231', 'sangue'],
  ['hdl', '48', 'sangue'],
  ['ldl', '158', 'sangue'],
  ['trigliceridi', '125', 'sangue'],
  ['ast', '24', 'sangue'],
  ['alt', '41', 'sangue'],
  ['gamma', '35', 'sangue'],
  ['ferritina', '145', 'sangue'],
  ['tsh', '2,15', 'sangue'],
  ['vitamina d', '18,4', 'sangue'],
  ['globuli bianchi', '6,8', 'sangue'],
  ['globuli rossi', '5,02', 'sangue'],
  ['emoglobina', '15,1', 'sangue'],
  ['ematocrito', '44,6', 'sangue'],
  ['piastrine', '231', 'sangue'],
  ['neutrofili', '58,1', 'sangue'],
  ['neutrofili', '3,95', 'sangue'],
  ['linfociti', '31,2', 'sangue'],
  ['linfociti', '2,12', 'sangue'],
  ['peso specifico', '1.020', 'urine'],
  ['glucosio', 'assente', 'urine'],
  ['proteine', 'assenti', 'urine'],
];

const config = loadConfig();
const gateway = createModelGateway({
  ...(config.providers.anthropicApiKey
    ? { anthropicApiKey: config.providers.anthropicApiKey }
    : {}),
  ...(config.providers.openrouterApiKey
    ? { openrouterApiKey: config.providers.openrouterApiKey }
    : {}),
  profiles: buildProfiles(config.llm.models),
});
let cost = 0;
const recorder: LlmCallRecorder = {
  record: async (c) => {
    cost += callCostUsd(c.usage, c.model);
  },
} as LlmCallRecorder;
const extract = createHealthExtractor({ gateway, recorder });
const t0 = Date.now();
const r = await extract(REFERTO, {
  userId: '00000000-0000-0000-0000-000000000000',
  documentTitle: 'Analisi ottobre',
});
if (!r) throw new Error('nessuna estrazione');
const items = r.items.map((i) => ({ ...i, n: i.name.toLowerCase().replace(/\s+/g, ' ') }));
let found = 0;
const used = new Set<number>();
for (const [name, value, section] of EXPECTED) {
  const idx = items.findIndex(
    (i, k) =>
      !used.has(k) &&
      i.n.includes(name) &&
      i.value.trim() === value &&
      (i.section ?? 'sangue') === section,
  );
  if (idx >= 0) {
    used.add(idx);
    found++;
  } else process.stdout.write(`manca: ${name} = ${value} (${section})\n`);
}
const extra = items.filter((_, k) => !used.has(k));
for (const e of extra)
  process.stdout.write(`in più: ${e.name} = ${e.value} (${e.section ?? '-'})\n`);
process.stdout.write(
  `referto: ${r.isLabReport} ${r.takenOn} «${r.lab}» «${r.kind}»\nrichiamo ${found}/${EXPECTED.length}, precisione ${found}/${items.length}, ${((Date.now() - t0) / 1000).toFixed(1)} s, $${cost.toFixed(4)}\n`,
);
