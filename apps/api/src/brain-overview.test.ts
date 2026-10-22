import { type BrainNote, type BrainService, buildBrainOverview } from '@ernie/brain';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { brainRoutes } from './routes/brain.js';

it('restituisce riepilogo e GPS solo dopo autenticazione, mantenendo il corpo originale', async () => {
  const note: BrainNote = {
    path: 'Luoghi/Casa.md',
    title: 'Casa',
    type: 'luogo',
    created: '2026-10-17',
    coords: [45.123456789, 13.123456789],
    links: [],
    private: false,
    body: '# Casa\n\nIngresso a destra.',
  };
  const read = vi
    .fn()
    .mockResolvedValue({ note, backlinks: [], overview: buildBrainOverview(note, []) });
  const app = Fastify();
  await app.register(brainRoutes, {
    brain: { read } as unknown as BrainService,
    allowedOrigins: [],
    authenticator: {
      authenticate: async (key) =>
        key === 'valid'
          ? {
              userId: 'owner',
              apiKeyId: 'test',
              role: 'owner',
              scopes: ['chat'],
              companionName: 'Ernie',
              settings: {},
            }
          : null,
    },
  });
  try {
    expect((await app.inject('/v1/brain/note?title=Casa')).statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/v1/brain/note?title=Casa',
      headers: { authorization: 'Bearer valid' },
    });
    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith('owner', 'Casa');
    expect(response.json().note).toMatchObject({
      body: note.body,
      coords: note.coords,
      overview: {
        facts: [{ text: 'Ingresso a destra.' }],
        places: [{ coords: note.coords, address: null }],
      },
    });
  } finally {
    await app.close();
  }
});
