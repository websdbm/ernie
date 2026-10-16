import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel } from 'ai';
import type { ClassProfile, ModelClass, ReasoningEffort } from './models.js';

export interface GatewayOptions {
  /** OpenRouter: via storica e riserva automatica quando Anthropic non risponde. */
  readonly openrouterApiKey?: string;
  /**
   * API di Anthropic diretta (13 ott 2026: crediti promozionali sull'organizzazione dell'utente). Se c'è,
   * è la via principale; OpenRouter resta la riserva se la richiesta fallisce in partenza (es. crediti finiti).
   */
  readonly anthropicApiKey?: string;
  readonly profiles: Readonly<Record<ModelClass, ClassProfile>>;
  /** Chiamato quando Anthropic rifiuta la richiesta e si ripiega su OpenRouter (es. crediti finiti). */
  readonly onFallback?: (info: { modelId: string; error: string }) => void;
  readonly appTitle?: string;
  readonly referer?: string;
}

export type GatewayProvider = 'openrouter' | 'anthropic';

export interface ResolvedModel {
  readonly profile: ClassProfile;
  /** Istanza AI SDK (specifica v4) accettata dal campo `model` di Mastra. */
  readonly model: ReturnType<typeof wrapLanguageModel>;
  readonly provider: GatewayProvider;
}

export function reasoningBody(effort: ReasoningEffort): Record<string, unknown> {
  // Su OpenRouter Sonnet 5.5 rifiuta il ragionamento spento («Reasoning is mandatory for this endpoint»): il 16 ott
  // 2026 un turno è fallito nel ripiego dopo un guasto DNS verso Anthropic. Lo sforzo minimo è accettato e su una
  // domanda semplice non ragiona (0 token, provato sul server).
  if (effort === 'off') return { reasoning: { effort: 'minimal' } };
  // Sui modelli 5.x il ragionamento è attivo di default: 'none' lo lascia al provider senza
  // aggiungere parametri (aggiungerne uno cambia la chiave di cache, spike M2.1 D1).
  return effort === 'none' ? {} : { reasoning: { effort } };
}

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Punti di cache stabili (16 ott 2026). Il contesto del turno sta subito prima del messaggio dell'utente e non
 * viene salvato: al turno dopo la richiesta cambia proprio lì, e il solo punto di cache automatico (in fondo alla
 * richiesta) non si ritrovava mai. Misurato in produzione: zero letture dalla cache, 15–17 mila token riscritti a
 * ogni turno, prima risposta dopo 4–8 s. Due punti in più: in fondo al prompt di sistema (strumenti, personalità e
 * scheda: si rileggono dal secondo turno) e sull'ultimo messaggio dell'assistente o risultato di uno strumento
 * (la cronologia si rilegge dal turno dopo). Con quello automatico sono tre, il massimo è quattro.
 */
export function markHistoryCache<M extends { role: string; providerOptions?: unknown }>(
  prompt: readonly M[],
): M[] {
  const out = [...prompt];
  const mark = (i: number) => {
    const m = out[i];
    if (!m) return;
    const options = (m.providerOptions ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    out[i] = {
      ...m,
      providerOptions: {
        ...options,
        anthropic: { ...(options.anthropic ?? {}), cacheControl: { type: 'ephemeral' } },
      },
    };
  };
  let lastSystem = -1;
  while (out[lastSystem + 1]?.role === 'system') lastSystem++;
  if (lastSystem >= 0 && lastSystem < out.length - 1) mark(lastSystem);
  let i = out.length - 1;
  while (i > lastSystem && out[i]?.role !== 'assistant' && out[i]?.role !== 'tool') i--;
  if (i > lastSystem) mark(i);
  return out;
}

/** «anthropic/claude-haiku-5.5» (OpenRouter) → «claude-haiku-5-5» (API di Anthropic). */
export function anthropicModelId(openrouterId: string): string {
  return openrouterId.replace(/^anthropic\//, '').replace(/\./g, '-');
}

/**
 * Model Gateway. Due vie con la stessa cache automatica di tutto il prefisso (`cache_control` nel corpo della
 * richiesta): API di Anthropic diretta se c'è la chiave, altrimenti OpenRouter (spike M2.1: cache, costo reale,
 * sticky routing). Con entrambe, un errore all'avvio della chiamata ad Anthropic ripiega su OpenRouter.
 */
export function createModelGateway(opts: GatewayOptions) {
  if (!opts.openrouterApiKey && !opts.anthropicApiKey)
    throw new Error('Model Gateway: serve una chiave OpenRouter o Anthropic');
  const openrouter = opts.openrouterApiKey
    ? createOpenRouter({
        apiKey: opts.openrouterApiKey,
        headers: {
          'HTTP-Referer': opts.referer ?? 'https://github.com/websdbm/ernie',
          'X-Title': opts.appTitle ?? 'Ernie',
        },
      })
    : null;
  const anthropic = opts.anthropicApiKey ? createAnthropic({ apiKey: opts.anthropicApiKey }) : null;

  const viaOpenRouter = (profile: ClassProfile, sessionId: string) =>
    openrouter?.chat(profile.modelId, {
      usage: { include: true },
      extraBody: {
        cache_control: { type: 'ephemeral' },
        session_id: sessionId,
        ...reasoningBody(profile.reasoning),
      },
    }) ?? null;

  const viaAnthropic = (profile: ClassProfile, fallback: ReturnType<typeof viaOpenRouter>) => {
    if (!anthropic) return null;
    const base = anthropic(anthropicModelId(profile.modelId));
    return wrapLanguageModel({
      model: base,
      middleware: {
        specificationVersion: 'v4',
        // Cache automatica del prefisso e sforzo di ragionamento fisso per classe (come su OpenRouter).
        transformParams: async ({ params }) => ({
          ...params,
          prompt: markHistoryCache(params.prompt),
          providerOptions: {
            ...params.providerOptions,
            anthropic: {
              ...(params.providerOptions?.anthropic ?? {}),
              cacheControl: { type: 'ephemeral' },
              ...(profile.reasoning === 'off'
                ? { thinking: { type: 'disabled' } }
                : profile.reasoning === 'none'
                  ? {}
                  : { effort: profile.reasoning }),
            },
          },
        }),
        ...(fallback
          ? {
              wrapStream: async ({ doStream, params }) => {
                try {
                  return await doStream();
                } catch (err) {
                  opts.onFallback?.({ modelId: profile.modelId, error: errorText(err) });
                  return fallback.doStream(params);
                }
              },
              wrapGenerate: async ({ doGenerate, params }) => {
                try {
                  return await doGenerate();
                } catch (err) {
                  opts.onFallback?.({ modelId: profile.modelId, error: errorText(err) });
                  return fallback.doGenerate(params);
                }
              },
            }
          : {}),
      },
    });
  };

  return {
    profiles: opts.profiles,
    provider: (anthropic ? 'anthropic' : 'openrouter') as GatewayProvider,
    /** Risolve il modello di una classe per una sessione (session_id = sessione Ernie, solo per OpenRouter). */
    resolve(modelClass: ModelClass, sessionId: string): ResolvedModel {
      const profile = opts.profiles[modelClass];
      const fallback = viaOpenRouter(profile, sessionId);
      const direct = viaAnthropic(profile, fallback);
      if (direct) return { profile, model: direct, provider: 'anthropic' };
      if (!fallback) throw new Error('Model Gateway: nessun provider disponibile');
      return { profile, model: fallback, provider: 'openrouter' };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;
