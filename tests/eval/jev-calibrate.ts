/**
 * Calibrazione delle soglie del router su un set etichettato (03-revisione A.11).
 * Esegue una chiamata Jev per esempio, poi per ogni domanda noul sceglie la soglia che massimizza
 * l'accuratezza bilanciata; riporta anche l'accuratezza di route e classe. Costo: ~60 × 0,00004 USD.
 *
 *   pnpm --filter @ernie/tests calibrate:jev            # stampa il report
 *   pnpm --filter @ernie/tests calibrate:jev --write    # aggiorna infrastructure/router/thresholds.json e docs/research/06-calibrazione-jev.md
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  buildQuestions,
  buildState,
  createHttpJevClient,
  type JevResponse,
  type RouterInput,
} from '@ernie/jev-router';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY mancante');
  process.exit(2);
}
const write = process.argv.includes('--write');

interface Example {
  text: string;
  route: 'deterministic' | 'skill' | 'llm';
  heavy: boolean;
  deep: boolean;
  memory: boolean;
  risk: boolean;
}
interface Dataset {
  toolCategories: string[];
  skillCandidates: string[];
  examples: Example[];
}

const dataset = JSON.parse(
  await readFile(new URL('./router-labeled.json', import.meta.url), 'utf8'),
) as Dataset;
const client = createHttpJevClient({ apiKey, title: 'Ernie calibrazione router' });

interface Row {
  ex: Example;
  res: JevResponse;
  ms: number;
}
const rows: Row[] = [];
let totalCost = 0;
for (const ex of dataset.examples) {
  const input: RouterInput = {
    text: ex.text,
    inputMode: 'text',
    recentTurns: [],
    toolCategories: dataset.toolCategories,
    skillCandidates: dataset.skillCandidates,
    sessionModelClass: 'standard',
  };
  const t0 = Date.now();
  const res = await client.decide({ state: buildState(input), questions: buildQuestions(input) });
  rows.push({ ex, res, ms: Date.now() - t0 });
  totalCost += res.usage?.cost ?? 0;
}

const noul = (r: JevResponse, q: string) => {
  const a = r.answers[q];
  return a?.type === 'noul' ? a.noul : 0;
};
const choice = (r: JevResponse, q: string) => {
  const a = r.answers[q];
  return a?.type === 'choice' ? a : undefined;
};

function balancedAccuracy(pred: boolean[], truth: boolean[]): number {
  let tp = 0,
    tn = 0,
    p = 0,
    n = 0;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i]) {
      p++;
      if (pred[i]) tp++;
    } else {
      n++;
      if (!pred[i]) tn++;
    }
  }
  const tpr = p ? tp / p : 1,
    tnr = n ? tn / n : 1;
  return (tpr + tnr) / 2;
}

function bestThreshold(
  q: string,
  label: keyof Example,
): { threshold: number; balancedAcc: number; at05: number } {
  const truth = rows.map((r) => Boolean(r.ex[label]));
  const probs = rows.map((r) => noul(r.res, q));
  let best = { threshold: 0.5, balancedAcc: -1 };
  for (let t = 0.2; t <= 0.8001; t += 0.05) {
    const acc = balancedAccuracy(
      probs.map((p) => p >= t),
      truth,
    );
    if (acc > best.balancedAcc + 1e-9) best = { threshold: Number(t.toFixed(2)), balancedAcc: acc };
  }
  return {
    ...best,
    at05: balancedAccuracy(
      probs.map((p) => p >= 0.5),
      truth,
    ),
  };
}

const deep = bestThreshold('deep_reasoning', 'deep');
const memory = bestThreshold('needs_memory', 'memory');
const risk = bestThreshold('risk', 'risk');
const routeAcc =
  rows.filter((r) => choice(r.res, 'route')?.choice === r.ex.route).length / rows.length;
const classAcc =
  rows.filter((r) => (choice(r.res, 'model_class')?.choice === 'heavy') === r.ex.heavy).length /
  rows.length;
const latencies = rows.map((r) => r.ms).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const routeConfusion: Record<string, Record<string, number>> = {};
for (const r of rows) {
  const pred = choice(r.res, 'route')?.choice ?? '?';
  const row = routeConfusion[r.ex.route] ?? {};
  routeConfusion[r.ex.route] = row;
  row[pred] = (row[pred] ?? 0) + 1;
}

const report = `# Calibrazione del router Jev

Eseguita il ${new Date().toISOString().slice(0, 10)} su ${rows.length} esempi etichettati (\`tests/eval/router-labeled.json\`), modello \`${rows[0]?.res.model ?? '?'}\`. Costo totale ${totalCost.toFixed(5)} USD; latenza p50 ${p50} ms, p95 ${p95} ms.

| Domanda | Soglia migliore | Accuratezza bilanciata | A 0,5 |
|---|---|---|---|
| deep_reasoning | ${deep.threshold} | ${(deep.balancedAcc * 100).toFixed(1)}% | ${(deep.at05 * 100).toFixed(1)}% |
| needs_memory | ${memory.threshold} | ${(memory.balancedAcc * 100).toFixed(1)}% | ${(memory.at05 * 100).toFixed(1)}% |
| risk | ${risk.threshold} | ${(risk.balancedAcc * 100).toFixed(1)}% | ${(risk.at05 * 100).toFixed(1)}% |

Accuratezza di \`route\` (scelta grezza): ${(routeAcc * 100).toFixed(1)}%. Accuratezza di \`model_class\` (heavy vs standard): ${(classAcc * 100).toFixed(1)}%.

Matrice di confusione di \`route\` (riga = etichetta, colonna = scelta Jev):

${Object.entries(routeConfusion)
  .map(
    ([t, preds]) =>
      `- ${t}: ${Object.entries(preds)
        .map(([p, n]) => `${p}=${n}`)
        .join(', ')}`,
  )
  .join('\n')}

Esempi sbagliati su route:
${
  rows
    .filter((r) => choice(r.res, 'route')?.choice !== r.ex.route)
    .map(
      (r) =>
        `- "${r.ex.text}" → atteso ${r.ex.route}, Jev ${choice(r.res, 'route')?.choice} (conf ${choice(r.res, 'route')?.confidence ?? '?'})`,
    )
    .join('\n') || '- nessuno'
}

Nota: il set è piccolo e scritto da chi progetta il sistema; le soglie vanno riviste con esempi reali raccolti da \`router_decisions\` (M9).
`;
console.log(report);
if (write) {
  const thresholds = {
    deepReasoning: deep.threshold,
    needsMemory: memory.threshold,
    risk: risk.threshold,
    routeConfidence: 0.5,
    classConfidence: 0.5,
  };
  await writeFile(
    new URL('../../infrastructure/router/thresholds.json', import.meta.url),
    `${JSON.stringify(thresholds, null, 2)}\n`,
  );
  await writeFile(new URL('../../docs/research/06-calibrazione-jev.md', import.meta.url), report);
  console.log('scritti thresholds.json e 06-calibrazione-jev.md');
}
