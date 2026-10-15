import { describe, expect, it } from 'vitest';
import { createMessagesSkill, messageFollowUp, parseMessageCommand } from './messages.js';
import { UnknownPersonError } from './reminder.js';

describe('skill Messaggi', () => {
  it('riconosce le frasi comuni con il testo; senza testo chiede cosa scrivere', () => {
    expect(parseMessageCommand('scrivi a Giorgio che la cena è pronta')).toEqual({
      op: 'send',
      who: 'Giorgio',
      text: 'La cena è pronta',
    });
    expect(parseMessageCommand('Manda un messaggio a papà: arrivo tra dieci minuti.')).toEqual({
      op: 'send',
      who: 'papà',
      text: 'Arrivo tra dieci minuti',
    });
    expect(parseMessageCommand('rispondi a papà: ok')).toMatchObject({ who: 'papà', text: 'Ok' });
    expect(parseMessageCommand("di' a nonna Pina che passiamo domenica")).toMatchObject({
      who: 'nonna Pina',
      text: 'Passiamo domenica',
    });
    expect(parseMessageCommand('[voce] Manda un messaggio a Giorgio')).toEqual({
      op: 'ask_text',
      who: 'Giorgio',
    });
    // Infinito («di' a Giorgio di venire») e altre frasi: le gestisce il modello.
    expect(parseMessageCommand("di' a Giorgio di venire a cena")).toBeNull();
    expect(parseMessageCommand('scrivi una nota sul compito di storia')).toBeNull();
    expect(parseMessageCommand('ricorda a Giorgio di chiamarmi alle 5')).toBeNull();
    expect(messageFollowUp({ kind: 'message', who: 'Giorgio' }, 'vieni a cena')).toEqual({
      op: 'send',
      who: 'Giorgio',
      text: 'Vieni a cena',
    });
    expect(messageFollowUp({ kind: 'message', who: 'Giorgio' }, 'annulla')).toBeNull();
  });

  it('manda il messaggio e mostra il blocco; persona sconosciuta → spiega come collegarla', async () => {
    const sent: Array<{ toLabel: string; text: string }> = [];
    const skill = createMessagesSkill({
      send: async (_u, input) => {
        if (input.toLabel === 'Marco') throw new UnknownPersonError('Marco');
        sent.push(input);
        return {
          label: 'Giorgio',
          block: {
            kind: 'family_message',
            id: '11111111-1111-4111-8111-111111111111',
            direction: 'out',
            otherUserId: '22222222-2222-4222-8222-222222222222',
            label: 'Giorgio',
            text: input.text,
            at: '2026-10-15T19:00:00.000Z',
          },
        };
      },
    });
    const ctx = { userId: 'u', sessionId: null, requestId: 'x' };
    const r = await skill.run({ op: 'send', who: 'Giorgio', text: 'La cena è pronta' }, ctx);
    expect(r.text).toBe('✉️ Mandato a Giorgio.');
    expect(r.blocks?.[0]).toMatchObject({ kind: 'family_message', direction: 'out' });
    expect(sent).toEqual([{ toLabel: 'Giorgio', text: 'La cena è pronta' }]);
    const unknown = await skill.run({ op: 'send', who: 'Marco', text: 'ciao' }, ctx);
    expect(unknown.text).toContain('Non conosco nessun «Marco»');
    const ask = await skill.run({ op: 'ask_text', who: 'Giorgio' }, ctx);
    expect(ask.awaiting).toEqual({ kind: 'message', who: 'Giorgio' });
  });
});
