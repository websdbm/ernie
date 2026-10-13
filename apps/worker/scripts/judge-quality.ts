/**
 * Prova del giudice delle contraddizioni (ricerca 11, M1) con il modello leggero vero, su coppie italiane.
 * Uso: node --env-file=.env --import tsx --conditions=development apps/worker/scripts/judge-quality.ts
 * Costo: una chiamata al modello leggero.
 */
import { loadConfig } from '@ernie/config';
import { createLlmJudge } from '@ernie/memory';
import { buildProfiles, createModelGateway } from '@ernie/model-gateway';

const config = loadConfig();
if (!config.providers.openrouterApiKey) throw new Error('OPENROUTER_API_KEY mancante');
const gateway = createModelGateway({
  openrouterApiKey: config.providers.openrouterApiKey,
  profiles: buildProfiles(config.llm.models),
});
let cost = 0;
const recorder = {
  record: async (r: { usage: { costReportedUsd?: number } }) => {
    cost += r.usage.costReportedUsd ?? 0;
  },
};
// [ricordo, fatto nuovo, attese ammesse]
const cases: Array<[string, string, string[]]> = [
  ['È vegetariano', 'Non è più vegetariano', ['contradicts']],
  ['Va in palestra il lunedì e il giovedì', 'Ha smesso di andare in palestra', ['contradicts']],
  ['Ha un cane di nome Fido', 'Il cane Fido è morto la settimana scorsa', ['contradicts']],
  [
    'Giorgio ha la verifica di storia venerdì',
    'La verifica di storia di Giorgio è stata spostata a lunedì',
    ['contradicts'],
  ],
  ['Abita a Mestre', 'Si è trasferito a Venezia a settembre', ['contradicts']],
  [
    'Lavora come insegnante a Milano',
    'Lavora come insegnante a Torino',
    ['contradicts', 'compatible'],
  ],
  ['Le piace la pizza', 'La sua pizza preferita è la margherita', ['refines', 'compatible']],
  ['Preferisce il tè la mattina', 'Fa colazione alle 7', ['compatible']],
  ['Ha un figlio di 13 anni, Giorgio', 'Giorgio gioca a calcio il martedì', ['compatible']],
  ['Segue una dieta senza glutine', 'Ieri sera ha mangiato una pizza normale', ['compatible']],
];
const judge = createLlmJudge({ gateway, recorder: recorder as never }, 'demo-user', 'demo-session');
const out = await judge({
  today: 'martedì 13 ottobre 2026',
  facts: cases.map(([old, nuovo]) => ({
    text: nuovo,
    validFrom: '2026-10-13',
    candidates: [{ text: old, since: '2026-09-01', trust: 0.8 }],
  })),
});
let ok = 0;
for (const [i, [old, nuovo, allowed]] of cases.entries()) {
  const d = out.decisions.find((x) => x.fact === i && x.candidate === 0);
  const pass = !!d && allowed.includes(d.relation);
  if (pass) ok++;
  process.stdout.write(
    `${pass ? 'OK ' : 'NO '} ${d?.relation ?? '(nessuna)'} ${d?.confidence ?? ''} | «${old}» → «${nuovo}» | prova: ${d?.evidence ?? ''}\n`,
  );
}
process.stdout.write(`\n${ok}/${cases.length} corretti, costo ${cost.toFixed(5)} $\n`);
