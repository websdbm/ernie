import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth.js';
import { ChatArchiveError, type ChatArchiveRepository } from '../chat-archive/types.js';
import { chatArchiveRoutes } from './chat-archives.js';

const a = randomUUID(),
  b = randomUUID(),
  archiveId = randomUUID();
async function setup(active = true, scopes = ['chat']) {
  const archive = { id: archiveId, name: 'Scuola sintetica' };
  const repo = {
    list: vi.fn(async () => ({ archives: [archive], total: 1 })),
    get: vi.fn(async (user, id) =>
      user === a && id === archiveId ? { archive, participants: [] } : null,
    ),
    messages: vi.fn(async () => ({ messages: [], total: 0 })),
    preview: vi.fn(async () => ({ parsedCount: 2 })),
    import: vi.fn(async () => ({ archive, insertedCount: 2 })),
    update: vi.fn(async () => archive),
    remove: vi.fn(async () => true),
    retrieve: vi.fn(),
  };
  const analysis = {
    ask: vi.fn(async () => ({ answer: 'Risposta', sources: [], uncertainties: [] })),
  };
  const app = Fastify({ logger: false });
  await app.register(chatArchiveRoutes, {
    authenticator: {
      authenticate: async (key: string): Promise<AuthContext | null> =>
        ['alice', 'bob'].includes(key)
          ? {
              userId: key === 'alice' ? a : b,
              apiKeyId: randomUUID(),
              scopes,
              role: 'member',
              companionName: 'Ernie',
              settings: {},
            }
          : null,
    } as never,
    allowedOrigins: [],
    repo: repo as unknown as ChatArchiveRepository,
    analysis: analysis as never,
    canUse: async () => active,
  });
  return { app, repo, analysis };
}
const headers = { authorization: 'Bearer alice' };
describe('HTTP archivio chat', () => {
  it('risolve riferimenti usando solo il catalogo e non trasferisce contenuti alla chat principale', async () => {
    const s = await setup();
    try {
      const r = await s.app.inject({
        method: 'POST',
        url: '/v1/chat-archives/resolve',
        headers,
        payload: { request: 'Nella chat Scuola sintetica cosa abbiamo deciso?' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().selectedArchiveId).toBe(archiveId);
      expect(s.repo.list).toHaveBeenCalledWith(a, { offset: 0, limit: 100 });
      expect(s.repo.messages).not.toHaveBeenCalled();
      expect(s.repo.retrieve).not.toHaveBeenCalled();
      expect(s.analysis.ask).not.toHaveBeenCalled();
      const p = await s.app.inject({
        method: 'PATCH',
        url: `/v1/chat-archives/${archiveId}`,
        headers,
        payload: { summary: 'Gruppo scuola e attività settimanali' },
      });
      expect(p.statusCode).toBe(200);
      expect(s.repo.update).toHaveBeenCalledWith(a, archiveId, {
        summary: 'Gruppo scuola e attività settimanali',
      });
    } finally {
      await s.app.close();
    }
  });

  it('richiede autenticazione, scope chat e skill attiva per tutte le operazioni', async () => {
    for (const [active, scopes, auth, status] of [
      [true, ['chat'], false, 401],
      [false, ['chat'], true, 403],
      [true, ['usage'], true, 403],
    ] as const) {
      const s = await setup(active, [...scopes]);
      try {
        const r = await s.app.inject({ url: '/v1/chat-archives', ...(auth ? { headers } : {}) });
        expect(r.statusCode).toBe(status);
        expect(s.repo.list).not.toHaveBeenCalled();
      } finally {
        await s.app.close();
      }
    }
  });
  it('passa il filtro dell’account autenticato e impedisce lettura di un’altra chat', async () => {
    const s = await setup();
    try {
      const result = await s.app.inject({ url: '/v1/chat-archives?q=scuola', headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(s.repo.list).toHaveBeenCalledWith(a, { query: 'scuola', offset: 0, limit: 40 });
      const other = await s.app.inject({
        url: `/v1/chat-archives/${archiveId}/messages`,
        headers: { authorization: 'Bearer bob' },
      });
      expect(other.statusCode).toBe(404);
      expect(s.repo.messages).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
  it('anteprima non importa e conferma esplicita mantiene destinazione e file', async () => {
    const s = await setup();
    const body = {
      filename: 'chat.txt',
      dataBase64: Buffer.from('testo sintetico').toString('base64'),
      timeZone: 'Europe/Rome',
    };
    try {
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/v1/chat-archives/imports/preview',
            headers,
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
      expect(s.repo.import).not.toHaveBeenCalled();
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/v1/chat-archives/imports',
            headers,
            payload: { ...body, archiveId },
          })
        ).statusCode,
      ).toBe(200);
      expect(s.repo.import).toHaveBeenCalledWith(a, { ...body, archiveId });
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/v1/chat-archives/imports',
            headers,
            payload: { ...body, archiveId, createNew: true },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await s.app.close();
    }
  });
  it('rifiuta AI senza consenso e filtri temporali invertiti', async () => {
    const s = await setup();
    try {
      const r = await s.app.inject({
        method: 'POST',
        url: `/v1/chat-archives/${archiveId}/ask`,
        headers,
        payload: { question: 'Riassumi', consent: false },
      });
      expect(r.statusCode).toBe(400);
      expect(s.analysis.ask).not.toHaveBeenCalled();
      const bad = await s.app.inject({
        url: `/v1/chat-archives/${archiveId}/messages?from=2026-11-05T10:00:00Z&to=2026-11-01T10:00:00Z`,
        headers,
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await s.app.close();
    }
  });
  it('un errore SQL non espone testo importato, password o dettagli interni', async () => {
    const s = await setup();
    try {
      s.repo.list.mockRejectedValueOnce(new Error('SQL FAILED imported-secret-canary dbpassword'));
      const r = await s.app.inject({ url: '/v1/chat-archives', headers });
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain('canary');
      expect(r.body).not.toContain('dbpassword');
    } finally {
      await s.app.close();
    }
  });
  it('conserva gli errori di disambiguazione senza avviare un’analisi', async () => {
    const s = await setup();
    try {
      s.repo.import.mockRejectedValueOnce(
        new ChatArchiveError(409, 'archive_choice_required', 'Scegli la chat da aggiornare.'),
      );
      const r = await s.app.inject({
        method: 'POST',
        url: '/v1/chat-archives/imports',
        headers,
        payload: { filename: 'chat.txt', dataBase64: 'YQ==', timeZone: 'Europe/Rome' },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('archive_choice_required');
      expect(s.analysis.ask).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
});
