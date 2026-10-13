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

function reasoningBody(effort: ReasoningEffort): Record<string, unknown> {
  // Sui modelli 5.x il ragionamento è attivo di default: 'none' lo lascia al provider senza
  // aggiungere parametri (aggiungerne uno cambia la chiave di cache, spike M2.1 D1).
  return effort === 'none' ? {} : { reasoning: { effort } };
}

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

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
          providerOptions: {
            ...params.providerOptions,
            anthropic: {
              ...(params.providerOptions?.anthropic ?? {}),
              cacheControl: { type: 'ephemeral' },
              ...(profile.reasoning === 'none' ? {} : { effort: profile.reasoning }),
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
