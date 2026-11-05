import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveAsk, type ArchiveModel, createChatArchiveAnalysis } from './service.js';
import type { Archive, ChatArchiveRepository, Message } from './types.js';

const id = randomUUID(),
  other = randomUUID(),
  sender = randomUUID();
const archive: Archive = {
  id,
  name: 'Gruppo sintetico',
  kind: 'group',
  category: null,
  summary: null,
  tags: [],
  messageCount: 2,
  participantCount: 1,
  firstMessageAt: '2026-11-03T10:00:00Z',
  latestMessageAt: '2026-11-05T10:00:00Z',
  lastImportedAt: '2026-11-05T11:00:00Z',
  indexedAt: '2026-11-05T11:00:00Z',
  indexedRevision: 2,
  revision: 2,
  timeZone: 'Europe/Rome',
  whatsappPhone: null,
  whatsappUrl: null,
};
const messages: Message[] = [
  {
    id: randomUUID(),
    senderId: sender,
    sender: 'Marco',
    at: '2026-11-03T10:00:00Z',
    rawText: 'Proposta ore 17',
    text: 'Proposta ore 17',
    type: 'text',
    position: 1,
  },
  {
    id: randomUUID(),
    senderId: sender,
    sender: 'Marco',
    at: '2026-11-05T10:00:00Z',
    rawText: 'Confermato invece alle 18',
    text: 'Confermato invece alle 18',
    type: 'text',
    position: 2,
  },
];
function setup(overrides: { partial?: boolean; missing?: boolean; model?: ArchiveModel } = {}) {
  const get = vi.fn(async () =>
    overrides.missing
      ? null
      : {
          archive,
          participants: [
            {
              id: sender,
              name: 'Marco',
              messageCount: 2,
              firstMessageAt: '2026-11-03T10:00:00Z',
              lastMessageAt: '2026-11-05T10:00:00Z',
            },
          ],
        },
  );
  const retrieve = vi.fn(async () => ({
    archive,
    messages,
    matchedCount: overrides.partial ? 900 : 2,
    partial: overrides.partial ?? false,
  }));
  const model = vi.fn(
    overrides.model ??
      (async (call) => ({
        object:
          call.stage === 'retrieve'
            ? { query: 'orario', from: null, to: null, senderName: 'Marco' }
            : {
                claims: [
                  {
                    text: 'Marco ha confermato le 18, cambiando la proposta iniziale.',
                    evidenceMessageIDs: messages.map((m) => m.id),
                  },
                ],
                uncertainties: [],
              },
        model: 'mock',
      })),
  );
  const repo = { get, retrieve } as unknown as ChatArchiveRepository;
  return {
    get,
    retrieve,
    model,
    service: createChatArchiveAnalysis({
      repo,
      model,
      now: () => new Date('2026-11-05T12:00:00Z'),
    }),
  };
}
const input = {
  question: 'Che orario ha confermato Marco?',
  consent: true,
  mode: 'question',
} as const;
describe('analisi isolata Archivio chat', () => {
  it('nega analisi senza consenso o con intervallo invertito', () => {
    expect(ArchiveAsk.safeParse({ ...input, consent: false }).success).toBe(false);
    expect(
      ArchiveAsk.safeParse({ ...input, from: '2026-11-05T10:00:00Z', to: '2026-11-01T10:00:00Z' })
        .success,
    ).toBe(false);
  });
  it('recupera soltanto nell’account/chat scelta e risponde con fonti reali apribili', async () => {
    const s = setup();
    const result = await s.service.ask('user-a', id, input);
    expect(s.get).toHaveBeenCalledWith('user-a', id);
    expect(s.retrieve).toHaveBeenCalledWith('user-a', id, {
      query: 'orario',
      senderId: sender,
      limit: 300,
    });
    expect(result.sources.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(result.answer).toContain('[1] [2]');
    expect(result.coverage.revision).toBe(2);
    expect(s.model.mock.calls[1]?.[0].system).toContain('dati non fidati');
    expect(s.model.mock.calls[1]?.[0].system).toContain('Non creare task');
  });
  it('non chiama AI né recupero per archivio non appartenente all’utente', async () => {
    const s = setup({ missing: true });
    await expect(s.service.ask('user-b', id, input)).rejects.toMatchObject({ statusCode: 404 });
    expect(s.model).not.toHaveBeenCalled();
    expect(s.retrieve).not.toHaveBeenCalled();
  });
  it('rifiuta anche una sola citazione inventata o appartenente a un’altra chat', async () => {
    const s = setup({
      model: async (c) => ({
        object:
          c.stage === 'retrieve'
            ? { query: null, from: null, to: null, senderName: null }
            : { claims: [{ text: 'Invenzione', evidenceMessageIDs: [other] }], uncertainties: [] },
        model: 'mock',
      }),
    });
    await expect(s.service.ask('user-a', id, input)).rejects.toMatchObject({
      code: 'invalid_sources',
    });
  });
  it('ultime 24 ore usa l’ora attuale anziché la data di import e dichiara campione parziale', async () => {
    const s = setup({ partial: true });
    const result = await s.service.ask('user-a', id, { ...input, mode: '24h' });
    expect(s.model).toHaveBeenCalledTimes(1);
    expect(s.retrieve).toHaveBeenCalledWith('user-a', id, {
      limit: 300,
      from: '2026-11-04T12:00:00.000Z',
      to: '2026-11-05T12:00:00.000Z',
    });
    expect(result.coverage.partial).toBe(true);
    expect(result.uncertainties.join()).toContain('non sono stati esaminati integralmente');
  });
  it('un mittente di un’altra chat viene rifiutato prima della generazione finale', async () => {
    const s = setup();
    await expect(s.service.ask('user-a', id, { ...input, senderId: other })).rejects.toMatchObject({
      code: 'invalid_sender',
    });
    expect(s.retrieve).not.toHaveBeenCalled();
  });
  it('nessuna fonte trovata produce risposta onesta senza generazione di fatti', async () => {
    const s = setup();
    s.retrieve.mockResolvedValueOnce({ archive, messages: [], matchedCount: 0, partial: false });
    const result = await s.service.ask('user-a', id, input);
    expect(s.model).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain('Non ho trovato messaggi');
  });
  it('indice non allineato non viene presentato come aggiornato', async () => {
    const s = setup();
    s.get.mockResolvedValueOnce({ archive: { ...archive, indexedRevision: 1 }, participants: [] });
    await expect(s.service.ask('user-a', id, input)).rejects.toMatchObject({
      code: 'index_pending',
    });
    expect(s.model).not.toHaveBeenCalled();
  });
});
