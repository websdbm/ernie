/**
 * Prova di qualità del riassunto della conversazione (ricerca 11 C1) con il modello leggero vero.
 * Uso: node --env-file=.env --import tsx --conditions=development apps/worker/scripts/summary-quality.ts
 * Costo: una chiamata al modello leggero (meno di un centesimo).
 */

import { loadConfig } from '@ernie/config';
import {
  createLlmSummarizer,
  ensureExactData,
  exactData,
  renderSessionSummary,
} from '@ernie/memory';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';

const config = loadConfig();
if (!config.providers.openrouterApiKey) throw new Error('OPENROUTER_API_KEY mancante');
const gateway = createModelGateway({
  openrouterApiKey: config.providers.openrouterApiKey,
  profiles: buildProfiles(config.llm.models),
});
const recorder = {
  record: async (r: { usage: unknown }) => console.error('[costo]', JSON.stringify(r.usage)),
};
const base = Date.UTC(2026, 9, 12, 16, 0, 0);
const dialog: Array<[string, string]> = [
  ['user', 'Ciao Ernie, domani Giorgio ha la verifica di storia sui Sumeri, alle 9:30.'],
  ['assistant', 'Ok! Vuoi che gli prepari uno schema a frecce sul capitolo dei Sumeri?'],
  ['user', 'Sì, sul capitolo 2, pagine 34-41. E mettimi un promemoria alle 7:15 per svegliarlo.'],
  [
    'assistant',
    'Fatto: promemoria impostato per domani alle 7:15. Ecco lo schema a frecce del capitolo 2.',
  ],
  ['user', 'Perfetto. Poi aggiungi alla lista Spesa 2 litri di latte e il pane integrale.'],
  ['assistant', 'Ho aggiunto alla lista «Spesa»: latte (2 l) e pane integrale.'],
  ['user', 'Ah, e preferisco che gli schemi siano più corti, massimo 6 frecce per sezione.'],
  ['assistant', 'Va bene, da ora farò schemi più corti, massimo 6 frecce per sezione.'],
  ['user', 'Quanto costa la gita a Ravenna? La maestra ha detto 38 euro, da pagare entro venerdì.'],
  [
    'assistant',
    'Me lo segno: gita a Ravenna, 38 euro, entro venerdì. Vuoi un promemoria per il pagamento?',
  ],
  ['user', 'Ci penso, te lo dico dopo.'],
  ['assistant', 'Va bene, quando vuoi.'],
];
const fold = dialog.map(([role, text], i) => ({
  id: `m${i}`,
  role,
  text,
  createdAt: new Date(base + i * 90_000),
}));
const summarizer = createLlmSummarizer(
  { gateway, recorder: recorder as never },
  'demo-user',
  'demo-session',
);
const today = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  dateStyle: 'full',
}).format(new Date(base));
const sections = ensureExactData(
  await summarizer({ previous: null, fold, today }),
  exactData(fold),
);
console.log(
  renderSessionSummary({
    sections,
    coveredUntil: new Date(),
    messages: fold.length,
    version: 1,
    fallback: false,
  }),
);
