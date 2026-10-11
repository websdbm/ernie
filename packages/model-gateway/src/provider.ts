import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ClassProfile, ModelClass, ReasoningEffort } from './models.js';

export interface GatewayOptions {
  readonly openrouterApiKey: string;
  readonly profiles: Readonly<Record<ModelClass, ClassProfile>>;
  readonly appTitle?: string;
  readonly referer?: string;
}

export interface ResolvedModel {
  readonly profile: ClassProfile;
  /** Istanza AI SDK accettata dal campo `model` di Mastra. */
  readonly model: ReturnType<ReturnType<typeof createOpenRouter>['chat']>;
  readonly provider: 'openrouter';
}

function reasoningBody(effort: ReasoningEffort): Record<string, unknown> {
  // Sui modelli 5.x il ragionamento è attivo di default: 'none' lo lascia al provider senza
  // aggiungere parametri (aggiungerne uno cambia la chiave di cache, spike M2.1 D1).
  return effort === 'none' ? {} : { reasoning: { effort } };
}

/**
 * Model Gateway: una sola via verificata (spike M2.1) per ottenere cache dei prompt, costo reale
 * e sticky routing da OpenRouter attraverso Mastra.
 */
export function createModelGateway(opts: GatewayOptions) {
  const openrouter = createOpenRouter({
    apiKey: opts.openrouterApiKey,
    headers: {
      'HTTP-Referer': opts.referer ?? 'https://github.com/websdbm/ernie',
      'X-Title': opts.appTitle ?? 'Ernie',
    },
  });

  return {
    profiles: opts.profiles,
    /** Risolve il modello di una classe per una sessione (session_id = sessione Ernie). */
    resolve(modelClass: ModelClass, sessionId: string): ResolvedModel {
      const profile = opts.profiles[modelClass];
      const model = openrouter.chat(profile.modelId, {
        usage: { include: true },
        extraBody: {
          cache_control: { type: 'ephemeral' },
          session_id: sessionId,
          ...reasoningBody(profile.reasoning),
        },
      });
      return { profile, model, provider: 'openrouter' };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;
