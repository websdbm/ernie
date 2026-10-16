import { describe, expect, it } from 'vitest';
import { buildProfiles } from './models.js';
import { anthropicModelId, createModelGateway, reasoningBody } from './provider.js';

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

describe('punto di cache in fondo alla cronologia', () => {
  it('sull’ultimo messaggio dell’assistente o dello strumento, non sul contesto del turno né sull’utente', async () => {
    const { markHistoryCache } = await import('./provider.js');
    type Msg = { role: string; content: unknown; providerOptions?: unknown };
    const prompt: Msg[] = [
      { role: 'system', content: 'soul' },
      { role: 'user', content: [{ type: 'text', text: 'ciao' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ciao!' }] },
      { role: 'user', content: [{ type: 'text', text: '[Contesto di questo turno…]' }] },
      { role: 'user', content: [{ type: 'text', text: 'e domani?' }] },
    ];
    const out = markHistoryCache(prompt);
    const mark = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    // In fondo al prompt di sistema e in fondo alla cronologia salvata.
    expect(out[0]?.providerOptions).toEqual(mark);
    expect(out[2]?.providerOptions).toEqual(mark);
    expect(out.filter((m) => m.providerOptions)).toHaveLength(2);
    expect(prompt[2]).not.toHaveProperty('providerOptions');
    // Primo turno: solo il prompt di sistema.
    const first = markHistoryCache(prompt.slice(0, 2));
    expect(first.map((m) => Boolean(m.providerOptions))).toEqual([true, false]);
    // Le opzioni già presenti restano.
    const kept = markHistoryCache([
      { role: 'system', content: 's' },
      { role: 'tool', content: [], providerOptions: { anthropic: { foo: 1 }, other: { x: 2 } } },
    ]);
    expect(kept[1]?.providerOptions).toEqual({
      anthropic: { foo: 1, cacheControl: { type: 'ephemeral' } },
      other: { x: 2 },
    });
    expect(kept[0]?.providerOptions).toEqual(mark);
  });
});

describe('reasoningBody (OpenRouter)', () => {
  it('«off» diventa lo sforzo minimo: su OpenRouter Sonnet 5.5 rifiuta il ragionamento spento', () => {
    expect(reasoningBody('off')).toEqual({ reasoning: { effort: 'minimal' } });
    expect(reasoningBody('none')).toEqual({});
    expect(reasoningBody('low')).toEqual({ reasoning: { effort: 'low' } });
  });
});
