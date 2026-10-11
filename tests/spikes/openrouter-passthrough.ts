/**
 * Spike M2.1 — passthrough OpenRouter e costruzione del payload da parte di Mastra.
 *
 * Domande a cui risponde (ARCHITECTURE.md §2, §19; 03-revisione §4):
 *  1. Con la stringa `openrouter/...` di Mastra, le richieste ottengono cache hit? Viene inviato `cache_control`?
 *  2. Con `@openrouter/ai-sdk-provider` (istanza AI SDK passata a Mastra), `usage.include`, `cache_control`
 *     e `session_id` arrivano al provider? Il costo torna nella risposta?
 *  3. In che ordine Mastra serializza `tools`, `messages` (system) e il resto? Il prefisso è stabile tra due turni?
 *  4. `reasoning.effort` passa? Tornano i reasoning tokens?
 *  5. `GET /api/v1/generation` conferma costo e token in cache?
 *
 * Esecuzione: `pnpm --filter @ernie/tests spike:openrouter` (richiede OPENROUTER_API_KEY in .env).
 * Costo atteso: pochi centesimi (modello light, ~1.500 token di prefisso, ~8 chiamate).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';

process.env.MASTRA_TELEMETRY_DISABLED = '1';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY mancante (atteso in .env)');
  process.exit(2);
}
const MODEL = process.env.SPIKE_MODEL ?? 'anthropic/claude-haiku-5.5';
const SESSION_ID = `ernie-spike-${Date.now().toString(36)}`;
const OUT_DIR = new URL('../out/', import.meta.url);

// ---------- cattura delle richieste/risposte verso OpenRouter ----------
interface Capture {
  label: string;
  url: string;
  status: number;
  requestBody: unknown;
  responseUsage: unknown;
  responseId: string | undefined;
  responseModel: string | undefined;
  responseKeys: string[];
}
const captures: Capture[] = [];
let currentLabel = 'n/a';
const realFetch = globalThis.fetch;

function parseResponseText(
  text: string,
  contentType: string,
): { usage: unknown; id: string | undefined; model: string | undefined; keys: string[] } {
  if (contentType.includes('text/event-stream')) {
    let usage: unknown;
    let id: string | undefined;
    let model: string | undefined;
    const keys = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data) as Record<string, unknown>;
        for (const k of Object.keys(evt)) keys.add(k);
        if (evt.usage) usage = evt.usage;
        if (typeof evt.id === 'string') id = evt.id;
        if (typeof evt.model === 'string') model = evt.model;
      } catch {
        /* frammento non JSON */
      }
    }
    return { usage, id, model, keys: [...keys] };
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return {
      usage: json.usage,
      id: typeof json.id === 'string' ? json.id : undefined,
      model: typeof json.model === 'string' ? json.model : undefined,
      keys: Object.keys(json),
    };
  } catch {
    return { usage: undefined, id: undefined, model: undefined, keys: [] };
  }
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const res = await realFetch(input, init);
  if (!url.includes('openrouter.ai')) return res;
  let requestBody: unknown;
  if (typeof init?.body === 'string') {
    try {
      requestBody = JSON.parse(init.body);
    } catch {
      requestBody = init.body;
    }
  }
  const clone = res.clone();
  const contentType = res.headers.get('content-type') ?? '';
  void clone.text().then((text) => {
    const parsed = parseResponseText(text, contentType);
    captures.push({
      label: currentLabel,
      url,
      status: res.status,
      requestBody,
      responseUsage: parsed.usage,
      responseId: parsed.id,
      responseModel: parsed.model,
      responseKeys: parsed.keys,
    });
  });
  return res;
}) as typeof fetch;

// ---------- prefisso stabile (> 512 token, soglia minima di cache per i modelli 5.x) ----------
const rules = Array.from(
  { length: 70 },
  (_, i) =>
    `Regola ${i + 1}: Ernie risponde in italiano, con frasi brevi e concrete, e non inventa fatti; quando non sa una cosa lo dice, e quando serve un dato personale lo cerca nella memoria prima di chiedere.`,
);
const CORE_SOUL = `Sei Ernie, un assistente personale persistente.\n${rules.join('\n')}`;

const getTime = createTool({
  id: 'get_time',
  description: "Restituisce l'ora corrente del server in formato ISO 8601.",
  inputSchema: z.object({ timezone: z.string().optional() }),
  outputSchema: z.object({ iso: z.string() }),
  execute: async () => ({ iso: new Date().toISOString() }),
});

const openrouter = createOpenRouter({
  apiKey,
  headers: { 'HTTP-Referer': 'https://github.com/websdbm/ernie', 'X-Title': 'Ernie spike M2.1' },
});

function sha(x: unknown): string {
  return createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12);
}

function summarizeBody(body: unknown) {
  if (!body || typeof body !== 'object') return { note: 'body non JSON' };
  const b = body as Record<string, unknown>;
  const messages = Array.isArray(b.messages) ? (b.messages as Array<Record<string, unknown>>) : [];
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const firstSystem = systemMsgs[0];
  const systemContent = firstSystem?.content;
  const systemHasCacheControl = JSON.stringify(systemContent ?? '').includes('cache_control');
  return {
    topLevelKeys: Object.keys(b),
    hasTools: 'tools' in b,
    toolsIndex: Object.keys(b).indexOf('tools'),
    messagesIndex: Object.keys(b).indexOf('messages'),
    messageRoles: messages.map((m) => m.role),
    systemAsMessage: systemMsgs.length > 0,
    systemContentType: typeof systemContent,
    systemHasCacheControl,
    topLevelCacheControl: 'cache_control' in b,
    usageInclude: (b.usage as Record<string, unknown> | undefined)?.include ?? null,
    sessionId: b.session_id ?? null,
    reasoning: b.reasoning ?? null,
    stream: b.stream ?? null,
    model: b.model,
    stablePrefixHash: sha({ tools: b.tools, system: systemContent, model: b.model }),
  };
}

type GenerateResult = Awaited<ReturnType<Agent['generate']>>;
function summarizeResult(r: GenerateResult) {
  const anyR = r as unknown as Record<string, unknown>;
  return {
    text: String(r.text).slice(0, 80),
    usage: r.usage,
    finishReason: r.finishReason,
    providerMetadata: anyR.providerMetadata,
    responseId: (anyR.response as Record<string, unknown> | undefined)?.id,
    toolCalls: (r.toolCalls ?? []).map(
      (t) => (t as { payload?: { toolName?: string } }).payload?.toolName,
    ),
  };
}

// `generate` è sovraccaricato e richiede sempre l'oggetto opzioni: nello spike lo passiamo non tipizzato.
async function run(
  label: string,
  agent: Agent,
  prompt: string,
  opts: Record<string, unknown> = {},
) {
  currentLabel = label;
  const t0 = Date.now();
  // max_tokens esplicito: senza, OpenRouter assume il massimo del modello (65.536) e verifica il saldo su quello.
  const merged = { modelSettings: { maxOutputTokens: 200 }, ...opts };
  const result = await agent.generate(prompt, merged as never);
  const ms = Date.now() - t0;
  // attende la cattura asincrona della risposta
  await new Promise((r) => setTimeout(r, 50));
  const cap = captures.filter((c) => c.label === label).at(-1);
  const summary = {
    label,
    ms,
    result: summarizeResult(result),
    request: summarizeBody(cap?.requestBody),
    rawUsage: cap?.responseUsage,
    responseKeys: cap?.responseKeys,
    generationId: cap?.responseId,
  };
  console.log(`\n=== ${label} (${ms} ms) ===`);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function fetchGeneration(id: string) {
  await new Promise((r) => setTimeout(r, 2500));
  const res = await realFetch(
    `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  const json = (await res.json()) as { data?: Record<string, unknown> };
  const d = json.data ?? {};
  const pick = [
    'model',
    'total_cost',
    'usage',
    'tokens_prompt',
    'tokens_completion',
    'native_tokens_prompt',
    'native_tokens_completion',
    'native_tokens_cached',
    'native_tokens_reasoning',
    'cache_discount',
    'latency',
    'generation_time',
    'provider_name',
  ];
  return Object.fromEntries(pick.filter((k) => k in d).map((k) => [k, d[k]]));
}

async function main() {
  const results: Record<string, unknown> = {
    model: MODEL,
    sessionId: SESSION_ID,
    startedAt: new Date().toISOString(),
  };
  const ask = 'Rispondi con la sola parola: ok';

  // ---- A: stringa nativa Mastra ----
  const agentA = new Agent({
    id: 'spike-a',
    name: 'Spike A',
    instructions: CORE_SOUL,
    model: `openrouter/${MODEL}`,
  });
  results.A1 = await run('A1 mastra-string first', agentA, ask);
  results.A2 = await run('A2 mastra-string second', agentA, ask);

  // ---- B: provider AI SDK OpenRouter con usage.include + cache_control automatico + session_id ----
  const modelB = openrouter.chat(MODEL, {
    usage: { include: true },
    extraBody: { cache_control: { type: 'ephemeral' }, session_id: SESSION_ID },
  });
  const agentB = new Agent({
    id: 'spike-b',
    name: 'Spike B',
    instructions: CORE_SOUL,
    model: modelB,
  });
  results.B1 = await run('B1 provider first', agentB, ask);
  results.B2 = await run('B2 provider second', agentB, ask);

  // ---- C: tool presenti → ordine del payload e stabilità del prefisso ----
  const agentC = new Agent({
    id: 'spike-c',
    name: 'Spike C',
    instructions: CORE_SOUL,
    model: modelB,
    tools: { getTime },
  });
  const c1 = await run(
    'C1 tools first',
    agentC,
    'Che ore sono adesso? Usa il tool e rispondi in una riga.',
  );
  const c2 = await run(
    'C2 tools second',
    agentC,
    'Che ore sono adesso? Usa il tool e rispondi in una riga.',
  );
  results.C1 = c1;
  results.C2 = c2;
  results.C_prefixStable = c1.request.stablePrefixHash === c2.request.stablePrefixHash;

  // ---- D: reasoning effort via providerOptions ----
  results.D1 = await run(
    'D1 reasoning low',
    agentB,
    'Quanto fa 17 per 23? Rispondi solo con il numero.',
    {
      providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
    },
  );

  // ---- E: riconciliazione costo via /api/v1/generation ----
  const genId =
    (results.B2 as { generationId?: string }).generationId ??
    (results.D1 as { generationId?: string }).generationId;
  if (genId) {
    results.E_generation = await fetchGeneration(genId);
    console.log('\n=== E generation ===');
    console.log(JSON.stringify(results.E_generation, null, 2));
  }

  await mkdir(OUT_DIR, { recursive: true });
  const file = new URL(`openrouter-passthrough-${Date.now()}.json`, OUT_DIR);
  const redactedCaptures = captures.map((c) => ({
    ...c,
    requestBody: (() => {
      const b = c.requestBody as Record<string, unknown> | undefined;
      if (!b || typeof b !== 'object') return b;
      const msgs = Array.isArray(b.messages) ? (b.messages as Array<Record<string, unknown>>) : [];
      return {
        ...b,
        messages: msgs.map((m) => ({
          ...m,
          content:
            typeof m.content === 'string'
              ? `${m.content.slice(0, 120)}… [${m.content.length} chars]`
              : m.content,
        })),
      };
    })(),
  }));
  await writeFile(file, JSON.stringify({ results, captures: redactedCaptures }, null, 2));
  console.log(`\nSalvato: ${file.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
