import type { BrainService } from '@ernie/brain';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { brainRoutes } from './routes/brain.js';

async function setup() {
  const note = {
    path: 'Persone/Anna.md',
    title: 'Anna',
    type: 'persona',
    created: '2026-10-21',
    body: 'Storia originale.',
    private: false,
    links: [],
    knowledge: { version: 1, facts: [], routines: [] },
  };
  const directory = vi.fn(async () => ({
    total: 1,
    groups: [{ type: 'persona', count: 1, notes: [] }],
    truncated: false,
  }));
  const agenda = vi.fn(async () => ({
    date: '2026-10-21',
    timeZone: 'Europe/Rome',
    subjects: [{ path: note.path, title: note.title }],
    entries: [],
  }));
  const updateKnowledge = vi.fn(async () => ({ note, backlinks: [] }));
  const app = Fastify();
  await app.register(brainRoutes, {
    brain: { directory, agenda, updateKnowledge } as unknown as BrainService,
    allowedOrigins: [],
    authenticator: {
      authenticate: async (key) =>
        key === 'valid' || key === 'other'
          ? {
              userId: key === 'valid' ? 'owner' : 'other-owner',
              apiKeyId: 'key',
              role: 'owner',
              scopes: ['chat'],
              companionName: 'Ernie',
              settings: {},
            }
          : null,
    },
  });
  return { app, directory, agenda, updateKnowledge };
}
const headers = { authorization: 'Bearer valid' };

describe('API schede fattuali', () => {
  it('richiede autenticazione e usa l’account della chiave per indice e agenda', async () => {
    const { app, directory, agenda } = await setup();
    try {
      expect((await app.inject('/v1/brain/directory')).statusCode).toBe(401);
      expect(directory).not.toHaveBeenCalled();
      expect((await app.inject({ url: '/v1/brain/directory', headers })).json().total).toBe(1);
      expect(directory).toHaveBeenCalledWith('owner', { includePrivate: true });
      const response = await app.inject({
        url: '/v1/brain/agenda?date=2026-10-21&timeZone=Europe%2FRome',
        headers: { authorization: 'Bearer other' },
      });
      expect(response.statusCode).toBe(200);
      expect(agenda).toHaveBeenCalledWith('other-owner', {
        date: '2026-10-21',
        timeZone: 'Europe/Rome',
        includePrivate: true,
      });
    } finally {
      await app.close();
    }
  });

  it('rifiuta date e payload non validi prima della persistenza', async () => {
    const { app, agenda, updateKnowledge } = await setup();
    try {
      expect(
        (
          await app.inject({
            url: '/v1/brain/agenda?date=2026-02-30&timeZone=Europe%2FRome',
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(agenda).not.toHaveBeenCalled();
      for (const payload of [
        { ref: 'Anna' },
        { ref: 'Anna', routines: [{ startTime: '25:00' }] },
        { ref: 'Anna', facts: [{ label: 'Sport', value: 'Nuoto' }], userId: 'other' },
      ]) {
        expect(
          (await app.inject({ method: 'PATCH', url: '/v1/brain/knowledge', headers, payload }))
            .statusCode,
        ).toBe(400);
      }
      expect(updateKnowledge).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rende la scheda corrente insieme al corpo storico, senza avviare notifiche', async () => {
    const { app, updateKnowledge } = await setup();
    try {
      const payload = { ref: 'Persone/Anna.md', facts: [{ label: 'Sport', value: 'Nuoto' }] };
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/brain/knowledge',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(updateKnowledge).toHaveBeenCalledWith('owner', payload);
      expect(response.json().note).toMatchObject({
        body: 'Storia originale.',
        knowledge: { version: 1 },
      });
    } finally {
      await app.close();
    }
  });
});
