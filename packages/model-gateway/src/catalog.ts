import { z } from 'zod';
import type { ClassProfile, ModelPrice, ReasoningEffort } from './models.js';
import { priceFor } from './models.js';

export type ModelSelection = {
  provider: 'anthropic' | 'openrouter';
  modelId: string;
  effort: 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};
export class ModelSelectionError extends Error {}
export interface ChatModel {
  id: string;
  provider: ModelSelection['provider'];
  name: string;
  efforts: ModelSelection['effort'][];
  contextTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  price: ModelPrice;
  sshEligible: boolean;
}
export interface ModelCatalog {
  models: ChatModel[];
  updatedAt: string;
  unavailable: string[];
}
const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const Supported = z.object({ supported: z.boolean().optional() }).passthrough();
const AnthropicModel = z.object({
  id: z.string(),
  display_name: z.string(),
  max_input_tokens: z.number(),
  max_tokens: z.number(),
  capabilities: z.object({
    effort: z.record(z.string(), z.unknown()).optional(),
    thinking: z.object({ types: z.record(z.string(), Supported).optional() }).optional(),
    image_input: Supported.optional(),
    structured_outputs: Supported.optional(),
  }),
});
const RouterModel = z.object({
  id: z.string(),
  name: z.string(),
  context_length: z.number(),
  supported_parameters: z.array(z.string()).default([]),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
  top_provider: z.object({ max_completion_tokens: z.number().nullable().optional() }),
  reasoning: z
    .object({
      supported_efforts: z.array(z.string()).nullable().optional(),
      mandatory: z.boolean().optional(),
    })
    .optional(),
});
// Direct pricing is explicitly known; an unpriced direct model is never presented as free.
const directPrice = (id: string): ModelPrice | undefined =>
  id === 'claude-fable-5-2'
    ? { inputPerM: 8, outputPerM: 40, cacheReadPerM: 0.2, cacheWritePerM: 10 }
    : priceFor(`anthropic/${id.replace(/(\d)-(\d)/g, '$1.$2')}`);
export const eligibleForSSH = (id: string) =>
  /^(?:anthropic\/)?claude-(?:opus-5[.-]5|fable-5[.-]2)$/.test(id);

export function parseAnthropicCatalog(data: unknown): ChatModel[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const parsed = AnthropicModel.safeParse(raw);
    if (!parsed.success) return [];
    const m = parsed.data,
      price = directPrice(m.id);
    // Adaptive thinking and structured tool output are required by this adapter.
    if (
      !price ||
      !m.capabilities.thinking?.types?.adaptive?.supported ||
      !m.capabilities.structured_outputs?.supported
    )
      return [];
    const supported = m.capabilities.effort ?? {};
    const supportedEfforts = efforts.filter(
      (e) => Supported.safeParse(supported[e]).data?.supported,
    );
    return [
      {
        id: m.id,
        provider: 'anthropic' as const,
        name: m.display_name,
        efforts: [
          'default',
          ...(m.capabilities.thinking.types.disabled?.supported ? ['off' as const] : []),
          ...supportedEfforts,
        ],
        contextTokens: m.max_input_tokens,
        maxOutputTokens: m.max_tokens,
        imageInput: m.capabilities.image_input?.supported === true,
        price,
        sshEligible: eligibleForSSH(m.id),
      },
    ];
  });
}
export function parseRouterCatalog(data: unknown): ChatModel[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const parsed = RouterModel.safeParse(raw);
    if (!parsed.success) return [];
    const m = parsed.data;
    if (
      m.context_length < 64000 ||
      !m.supported_parameters.includes('tools') ||
      !m.architecture.input_modalities.includes('text') ||
      !m.architecture.output_modalities.includes('text') ||
      /:|auto|router/i.test(m.id)
    )
      return [];
    const input = Number(m.pricing.prompt) * 1e6,
      output = Number(m.pricing.completion) * 1e6;
    if (![input, output].every((n) => Number.isFinite(n) && n >= 0)) return [];
    const read = Number(m.pricing.input_cache_read ?? m.pricing.prompt) * 1e6;
    const write = Number(m.pricing.input_cache_write ?? m.pricing.prompt) * 1e6;
    if (![read, write].every((n) => Number.isFinite(n) && n >= 0)) return [];
    const supported = m.reasoning?.supported_efforts;
    return [
      {
        id: m.id,
        provider: 'openrouter' as const,
        name: m.name,
        efforts: [
          'default',
          ...(supported?.includes('none') && !m.reasoning?.mandatory ? ['off' as const] : []),
          ...efforts.filter((e) => supported === null || supported?.includes(e)),
        ],
        contextTokens: m.context_length,
        maxOutputTokens: m.top_provider.max_completion_tokens ?? 4096,
        imageInput: m.architecture.input_modalities.includes('image'),
        sshEligible: eligibleForSSH(m.id),
        price: { inputPerM: input, outputPerM: output, cacheReadPerM: read, cacheWritePerM: write },
      },
    ];
  });
}

export function selectionProfile(
  selection: ModelSelection,
  catalog: ModelCatalog,
  base: ClassProfile,
): ClassProfile {
  const m = catalog.models.find(
    (m) => m.id === selection.modelId && m.provider === selection.provider,
  );
  if (!m)
    throw new ModelSelectionError(
      'Il modello scelto non è disponibile. Apri Maximize e scegli un modello oppure Automatico.',
    );
  if (!m.efforts.includes(selection.effort))
    throw new ModelSelectionError('Questo livello di sforzo non è supportato dal modello.');
  const reasoning: ReasoningEffort = selection.effort === 'default' ? 'none' : selection.effort;
  return {
    ...base,
    modelId: m.id,
    reasoning,
    maxOutputTokens: Math.min(
      m.maxOutputTokens,
      ['none', 'high', 'xhigh', 'max'].includes(reasoning) ? 32768 : 16384,
    ),
    price: m.price,
  };
}

/** Shared provider catalog, no user data. Fail closed after TTL; one in-flight refresh. */
export function createChatModelCatalog(
  keys: { anthropicApiKey?: string | undefined; openrouterApiKey?: string | undefined },
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  let cached: ModelCatalog | undefined;
  let pending: Promise<ModelCatalog> | undefined;
  async function read(): Promise<ModelCatalog> {
    const providers = [
      ...(keys.anthropicApiKey
        ? [
            {
              name: 'anthropic',
              url: 'https://api.anthropic.com/v1/models?limit=100',
              headers: { 'x-api-key': keys.anthropicApiKey, 'anthropic-version': '2026-10-21' },
              parse: parseAnthropicCatalog,
            },
          ]
        : []),
      ...(keys.openrouterApiKey
        ? [
            {
              name: 'openrouter',
              url: 'https://openrouter.ai/api/v1/models',
              headers: { Authorization: `Bearer ${keys.openrouterApiKey}` },
              parse: parseRouterCatalog,
            },
          ]
        : []),
    ];
    const results = await Promise.allSettled(
      providers.map(async (p) => {
        const r = await fetcher(p.url, { headers: p.headers, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('catalog unavailable');
        const data = z.object({ data: z.array(z.unknown()) }).parse(await r.json());
        return p.parse(data.data);
      }),
    );
    cached = {
      updatedAt: new Date(now()).toISOString(),
      models: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
      unavailable: results.flatMap((r, i) => {
        const provider = providers[i];
        return r.status === 'rejected' && provider ? [provider.name] : [];
      }),
    };
    return cached;
  }
  return {
    async get(refresh = false): Promise<ModelCatalog> {
      if (
        cached &&
        now() - Date.parse(cached.updatedAt) <
          (refresh || cached.unavailable.length ? 30000 : 900000)
      )
        return cached;
      if (!pending)
        pending = read().finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
