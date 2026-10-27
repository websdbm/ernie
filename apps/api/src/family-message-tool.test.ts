import { RunContext } from '@ernie/agent-core';
import { describe, expect, it } from 'vitest';
import {
  createFamilyMessageTool,
  type FamilyMessage,
  type FamilyMessenger,
  sameText,
} from './family-messages.js';

const sent: FamilyMessage = {
  id: 'm1',
  direction: 'out',
  otherUserId: 'giorgio',
  label: 'Giorgio',
  text: 'Facciamo colazione',
  image: null,
  replyTo: null,
  at: new Date('2026-10-16T04:54:09Z'),
  readAt: null,
  urgent: true,
  acknowledgedAt: new Date('2026-10-16T05:05:00Z'),
};

function fakeMessenger(previous: FamilyMessage | null) {
  const calls: string[] = [];
  const messenger = {
    recentSame: async (_u: string, input: { toLabel: string; text: string }) =>
      previous && sameText(previous.text) === sameText(input.text) ? previous : null,
    sendToLabel: async (_u: string, input: { toLabel: string; text: string }) => {
      calls.push(input.text);
      return { ...sent, id: `m${calls.length + 1}`, text: input.text };
    },
  } as unknown as FamilyMessenger;
  return { messenger, calls };
}

const ctx = {
  userId: 'papa',
  sessionId: null,
  requestId: 'r1',
  scopes: [],
  run: new RunContext('papa', [], 0),
};

describe('family_message_send: niente doppioni', () => {
  it('confronta i testi senza maiuscole e punteggiatura', () => {
    expect(sameText('Facciamo colazione!')).toBe(sameText('facciamo   colazione'));
    expect(sameText('Facciamo colazione')).not.toBe(sameText('Facciamo merenda'));
  });

  it('lo stesso testo già partito non riparte, e il motivo dice ora, urgenza e conferma', async () => {
    const { messenger, calls } = fakeMessenger(sent);
    const tool = createFamilyMessageTool(messenger);
    await expect(
      tool.execute({ to: 'Giorgio', text: 'Facciamo colazione!', urgent: true }, ctx),
    ).rejects.toThrow(/già partito alle 06:54 come urgente ed è stato confermato/);
    expect(calls).toEqual([]);
  });

  it('riparte solo con resend; un testo diverso parte subito', async () => {
    const { messenger, calls } = fakeMessenger(sent);
    const tool = createFamilyMessageTool(messenger);
    await tool.execute({ to: 'Giorgio', text: 'Facciamo colazione', resend: true }, ctx);
    await tool.execute({ to: 'Giorgio', text: 'Vieni a cena' }, ctx);
    expect(calls).toEqual(['Facciamo colazione', 'Vieni a cena']);
  });

  it('lascia i dettagli nella scheda e non presume audio o consegna dal solo invio', async () => {
    const { messenger } = fakeMessenger(null);
    const tool = createFamilyMessageTool(messenger);
    const result = tool.outputSchema.parse(
      await tool.execute({ to: 'Giorgio', text: 'Vieni a cena', urgent: true }, ctx),
    ) as { id: string; to: string; notice: string };
    expect(result.notice).toContain('una sola frase breve');
    expect(result.notice).toContain('Non affermare che il telefono stia suonando');
    expect(
      tool.present?.({ to: 'Giorgio', text: 'Vieni a cena', urgent: true }, result),
    ).toMatchObject({
      kind: 'family_message',
      text: 'Vieni a cena',
      label: 'Giorgio',
      urgent: true,
    });
  });
});
