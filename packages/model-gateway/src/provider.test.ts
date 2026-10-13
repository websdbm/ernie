import { describe, expect, it } from 'vitest';
import { buildProfiles } from './models.js';
import { anthropicModelId, createModelGateway } from './provider.js';

const profiles = buildProfiles({
  light: 'anthropic/claude-haiku-5.5',
  standard: 'anthropic/claude-sonnet-5.5',
  heavy: 'anthropic/claude-opus-5.5',
});

describe('Model Gateway: scelta del provider', () => {
  it('converte gli identificativi OpenRouter in quelli dell’API di Anthropic', () => {
    expect(anthropicModelId('anthropic/claude-haiku-5.5')).toBe('claude-haiku-5-5');
    expect(anthropicModelId('anthropic/claude-opus-4.7')).toBe('claude-opus-4-7');
  });

  it('con la chiave Anthropic usa l’API diretta, altrimenti OpenRouter; senza chiavi rifiuta', () => {
    expect(
      createModelGateway({ anthropicApiKey: 'k', openrouterApiKey: 'o', profiles }).resolve(
        'light',
        's',
      ).provider,
    ).toBe('anthropic');
    expect(
      createModelGateway({ openrouterApiKey: 'o', profiles }).resolve('heavy', 's').provider,
    ).toBe('openrouter');
    expect(() => createModelGateway({ profiles })).toThrow();
  });
});
