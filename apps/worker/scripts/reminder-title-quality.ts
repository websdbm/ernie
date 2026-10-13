/**
 * Prova dei titoli dei promemoria con il modello leggero vero (frasi dette a voce).
 * Uso: node --env-file=.env --import tsx --conditions=development apps/worker/scripts/reminder-title-quality.ts
 */
import { createReminderTitler } from '@ernie/agent-core';
import { loadConfig } from '@ernie/config';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';
import { tidyReminderText } from '@ernie/skills';

const config = loadConfig();
const gateway = createModelGateway({
  openrouterApiKey: config.providers.openrouterApiKey as string,
  profiles: buildProfiles(config.llm.models),
});
let cost = 0;
const recorder = {
  record: async (r: { usage: { costReportedUsd?: number } }) => {
    cost += r.usage.costReportedUsd ?? 0;
  },
};
const titler = createReminderTitler({
  gateway,
  recorder: recorder as never,
  fallback: tidyReminderText,
});
const cases: Array<[string, string | undefined]> = [
  ['uscire per andare a prendere Giorgio e portare la visita', undefined],
  ['andare a lavoro', undefined],
  ['chiamare quello della caldaia perché non parte più', undefined],
  ['che devo comprare il regalo per la maestra che va in pensione', undefined],
  ['chiamarmi', 'papà'],
  ['portarmi il libro di storia che l’ho lasciato a casa', 'papà'],
];
for (const [text, fromLabel] of cases) {
  const t0 = Date.now();
  const title = await titler(text, { userId: 'demo', ...(fromLabel ? { fromLabel } : {}) });
  process.stdout.write(
    `${String(Date.now() - t0).padStart(5)} ms | «${text}»${fromLabel ? ` (da ${fromLabel})` : ''} → ${title}\n`,
  );
}
process.stdout.write(`costo totale ${cost.toFixed(5)} $\n`);
