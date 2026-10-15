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
    const close = createMessagesSkill({
      send: async (_u, input) => {
        throw new UnknownPersonError(input.toLabel, 'papo');
      },
    });
    const suggested = await close.run({ op: 'send', who: 'papi', text: 'Porto io il pane' }, ctx);
    expect(suggested.text).toBe('Non trovo «papi» in Famiglia: intendevi papo?');
    expect(suggested.blocks?.[0]).toMatchObject({
      kind: 'choices',
      options: [{ label: 'Scrivi a papo che porto io il pane' }, { label: 'No, lascia stare' }],
    });
    const unknown = await skill.run({ op: 'send', who: 'Marco', text: 'ciao' }, ctx);
    expect(unknown.text).toContain('Non conosco nessun «Marco»');
    const ask = await skill.run({ op: 'ask_text', who: 'Giorgio' }, ctx);
    expect(ask.awaiting).toEqual({ kind: 'message', who: 'Giorgio' });
  });

  it('urgente («super snooze»): dalla parte di comando, non dal testo del messaggio', () => {
    expect(
      parseMessageCommand('Manda un messaggio urgente a Giorgio: torna subito a casa'),
    ).toEqual({
      op: 'send',
      who: 'Giorgio',
      text: 'Torna subito a casa',
      urgent: true,
    });
    expect(parseMessageCommand('messaggio urgente a Giorgio: chiamami')).toMatchObject({
      who: 'Giorgio',
      urgent: true,
    });
    expect(parseMessageCommand('manda un super snooze a Giorgio: sveglia!')).toMatchObject({
      who: 'Giorgio',
      text: 'Sveglia!',
      urgent: true,
    });
    expect(parseMessageCommand('Urgente: scrivi a Giorgio che deve chiamarmi')).toMatchObject({
      who: 'Giorgio',
      urgent: true,
    });
    expect(parseMessageCommand('scrivi a Giorgio urgente: rispondi al telefono')).toMatchObject({
      who: 'Giorgio',
      text: 'Rispondi al telefono',
      urgent: true,
    });
    // «urgente» dentro il messaggio non lo rende urgente.
    expect(parseMessageCommand('scrivi a Giorgio che è urgente comprare il pane')).toEqual({
      op: 'send',
      who: 'Giorgio',
      text: 'È urgente comprare il pane',
    });
    expect(parseMessageCommand('manda un messaggio urgente a Giorgio')).toEqual({
      op: 'ask_text',
      who: 'Giorgio',
      urgent: true,
    });
    expect(messageFollowUp({ kind: 'message', who: 'Giorgio', urgent: true }, 'torna')).toEqual({
      op: 'send',
      who: 'Giorgio',
      text: 'Torna',
      urgent: true,
    });
  });

  it('urgente: lo dice nella risposta; a chi non è un figlio propone il messaggio normale', async () => {
    const sent: unknown[] = [];
    const ctx = { userId: 'u', sessionId: null, requestId: 'x' };
    const skill = createMessagesSkill({
      send: async (_u, input) => {
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
            urgent: true,
          },
        };
      },
    });
    const r = await skill.run({ op: 'send', who: 'Giorgio', text: 'Torna', urgent: true }, ctx);
    expect(r.text).toContain('come urgente');
    expect(sent).toEqual([{ toLabel: 'Giorgio', text: 'Torna', urgent: true }]);
    const refused = createMessagesSkill({
      send: async () => {
        throw Object.assign(new Error('no'), { name: 'UrgentNotAllowedError' });
      },
    });
    const no = await refused.run({ op: 'send', who: 'papo', text: 'Vieni', urgent: true }, ctx);
    expect(no.text).toContain('solo ai figli');
    expect(no.blocks?.[0]).toMatchObject({
      kind: 'choices',
      options: [{ label: 'Scrivi a papo che vieni' }, { label: 'No, lascia stare' }],
    });
  });
});
