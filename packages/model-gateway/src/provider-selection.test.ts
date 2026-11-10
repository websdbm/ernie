import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProfiles } from './models.js';
import { createModelGateway } from './provider.js';

const profiles = buildProfiles({
  light: 'anthropic/claude-haiku-5.5',
  standard: 'anthropic/claude-sonnet-5.5',
  heavy: 'anthropic/claude-opus-5.5',
  standardReasoning: 'off',
});
afterEach(() => vi.unstubAllGlobals());

describe('provider request contract', () => {
  it('sends Sol only to OpenRouter with the exact chosen effort', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-6.1-sol',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const gateway = createModelGateway({
      profiles,
      anthropicApiKey: 'fake',
      openrouterApiKey: 'fake',
    });
    const choice = {
      provider: 'openrouter' as const,
      modelId: 'openai/gpt-6.1-sol',
      effort: 'max' as const,
    };
    const resolved = gateway.resolve('standard', 's', {
      selection: choice,
      profile: { ...profiles.standard, modelId: choice.modelId, reasoning: 'max' },
    });
    expect(
      (
        await generateText({
          model: resolved.model,
          prompt: 'test',
          maxOutputTokens: 100,
          maxRetries: 0,
        })
      ).text,
    ).toBe('OK');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('openrouter.ai');
    expect(requests[0]?.body).toMatchObject({
      model: choice.modelId,
      reasoning: { effort: 'max' },
    });
  });
  it('does not silently fall back when an explicitly chosen provider has no credits', async () => {
    const fetcher = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'insufficient credits' },
          }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const gateway = createModelGateway({
      profiles,
      anthropicApiKey: 'fake',
      openrouterApiKey: 'fake',
    });
    const resolved = gateway.resolve('standard', 's', {
      selection: { provider: 'anthropic', modelId: 'claude-sonnet-5-5', effort: 'low' },
      profile: { ...profiles.standard, modelId: 'claude-sonnet-5-5', reasoning: 'low' },
    });
    await expect(
      generateText({ model: resolved.model, prompt: 'test', maxOutputTokens: 100, maxRetries: 0 }),
    ).rejects.toThrow('credits');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('api.anthropic.com');
  });
  it('maps automatic Sonnet off explicitly to between_tools', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const gateway = createModelGateway({ profiles, anthropicApiKey: 'fake' });
    await generateText({
      model: gateway.resolve('standard', 's').model,
      prompt: 'test',
      maxRetries: 0,
    });
    expect(body.thinking).toEqual({ type: 'between_tools' });
  });
});
