/**
 * Sonda dell'API di Anthropic diretta nel Model Gateway (13 ott 2026): due chiamate con lo stesso prefisso
 * lungo (la seconda deve leggere dalla cache), una in streaming, uso normalizzato e costo stimato.
 * Uso: node --env-file=.env --import tsx --conditions=development packages/agent-core/scripts/anthropic-probe.ts
 */
import { loadConfig } from '@ernie/config';
import {
  buildProfiles,
  createModelGateway,
  estimateCostForModel,
  normalizeUsage,
} from '@ernie/model-gateway';
import { Agent } from '@mastra/core/agent';

const config = loadConfig();
const key = config.providers.anthropicApiKey;
if (!key) throw new Error('chiave Anthropic mancante (ANTHROPIC_API_KEY o CLAUDE_API_KEY)');
// PROBE_FALLBACK=1: anche OpenRouter, per provare il ripiego quando Anthropic rifiuta la richiesta.
const fallbackKey =
  process.env.PROBE_FALLBACK === '1' ? config.providers.openrouterApiKey : undefined;
const gateway = createModelGateway({
  anthropicApiKey: key,
  ...(fallbackKey ? { openrouterApiKey: fallbackKey } : {}),
  profiles: buildProfiles(config.llm.models),
});
const cls = (process.argv[2] ?? 'light') as 'light' | 'standard' | 'heavy';
const resolved = gateway.resolve(cls, 'probe-session');
// Prefisso lungo e stabile (oltre la soglia minima della cache).
const filler = Array.from(
  { length: 400 },
  (_, i) =>
    `Regola ${i + 1}: rispondi in italiano, con frasi brevi e chiare, senza elenchi inutili.`,
).join('\n');
const agent = new Agent({
  id: 'probe',
  name: 'probe',
  instructions: `Sei Ernie, un assistente.\n${filler}`,
  model: resolved.model,
});

// Come una conversazione: il secondo turno contiene il primo, quindi il suo prefisso è già in cache.
const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
for (const [i, q] of [
  'Dimmi una parola che inizia con A.',
  'Dimmi una parola che inizia con B.',
].entries()) {
  const t0 = Date.now();
  history.push({ role: 'user', content: q });
  const r = (await agent.generate(history, {
    modelSettings: { maxOutputTokens: 200 },
  } as never)) as unknown as {
    text: string;
    usage?: unknown;
    providerMetadata?: unknown;
  };
  history.push({ role: 'assistant', content: r.text });
  const u = normalizeUsage(r.usage, r.providerMetadata);
  console.log(
    `${i + 1}) ${resolved.provider} ${resolved.profile.modelId} ${Date.now() - t0} ms «${r.text.trim().slice(0, 40)}» in=${u.inputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens} out=${u.outputTokens} costo≈${estimateCostForModel(u, resolved.profile.modelId).toFixed(5)}$`,
  );
}
const s = await agent.stream('Conta da 1 a 5.', {
  modelSettings: { maxOutputTokens: 100 },
} as never);
let text = '';
for await (const chunk of s.textStream) text += chunk;
console.log(`streaming: «${text.trim().slice(0, 60)}»`);
