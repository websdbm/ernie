import { describe, expect, it } from 'vitest';
import { type FamilyMessage, familyPush } from './family-messages.js';

const message = (over: Partial<FamilyMessage>): FamilyMessage => ({
  id: 'm1',
  direction: 'in',
  otherUserId: 'papa-id',
  label: 'papo',
  text: 'Arrivo tra dieci minuti',
  image: null,
  replyTo: null,
  at: new Date('2026-10-15T20:00:00Z'),
  readAt: null,
  urgent: false,
  acknowledgedAt: null,
  ...over,
});

describe('notifica di un messaggio in famiglia', () => {
  it('urgente, con «Rispondi» e i dati per mostrarla come un messaggio', () => {
    expect(familyPush(message({}))).toEqual({
      title: '✉️ papo',
      body: 'Arrivo tra dieci minuti',
      data: { kind: 'family_message', id: 'm1', from: 'papa-id', label: 'papo', image: false },
      threadId: 'family-papa-id',
      interruptionLevel: 'time-sensitive',
      category: 'FAMILY_MESSAGE',
    });
  });

  it('foto: «📷 Foto» senza testo, «📷 …» con il testo', () => {
    expect(familyPush(message({ text: '', image: { width: 10, height: 10 } })).body).toBe(
      '📷 Foto',
    );
    const p = familyPush(message({ text: 'Guarda!', image: { width: 10, height: 10 } }));
    expect(p.body).toBe('📷 Guarda!');
    expect(p.data.image).toBe(true);
  });

  it('urgente: titolo, suono e sostituzione propri, categoria con la conferma', () => {
    const p = familyPush(message({ urgent: true }));
    expect(p).toMatchObject({
      title: '🚨 Urgente da papo',
      subtitle: 'Aprilo e conferma di averlo letto',
      category: 'FAMILY_URGENT',
      sound: 'urgente.caf',
      collapseId: 'm1',
      interruptionLevel: 'time-sensitive',
    });
    expect(p.data.urgent).toBe(true);
  });
});
