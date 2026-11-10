import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { type DocumentsRoutesOptions, documentsRoutes } from '../routes/documents.js';
import { type MediaRoutesOptions, mediaRoutes } from '../routes/media.js';
import { isPrivateHealthDocument } from './classification.js';

const authenticator = {
  authenticate: async () => ({
    userId: randomUUID(),
    apiKeyId: randomUUID(),
    scopes: ['chat'],
    role: 'owner' as const,
    companionName: 'Ernie',
    settings: {},
  }),
};
describe('health ingress containment', () => {
  it.each(['Referto laboratorio', 'Emocromo', 'Glicemia e colesterolo', 'Paziente: 90 mg/dL'])(
    'recognizes %s without AI',
    (text) => expect(isPrivateHealthDocument(text)).toBe(true),
  );
  it('keeps ordinary recipe and school uploads available', () => {
    expect(isPrivateHealthDocument('Muffin: 200g farina e 100g zucchero')).toBe(false);
    expect(isPrivateHealthDocument('La storia dei romani')).toBe(false);
  });
  it('rejects clinical document before repository or index writes', async () => {
    const create = vi.fn();
    const onCreated = vi.fn();
    const app = Fastify();
    await app.register(documentsRoutes, {
      authenticator,
      allowedOrigins: [],
      repo: { create } as unknown as DocumentsRoutesOptions['repo'],
      onCreated,
    });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/documents',
        headers: { authorization: 'Bearer fixture' },
        payload: { source: 'scan', pages: ['Referto sintetico - paziente privato'] },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('health_private_upload');
      expect(create).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects clinical photo before thumbnail, classifier, DB and Brain', async () => {
    const create = vi.fn(),
      thumbnail = vi.fn(),
      labeler = vi.fn();
    const app = Fastify();
    await app.register(mediaRoutes, {
      authenticator,
      allowedOrigins: [],
      repo: { create } as unknown as MediaRoutesOptions['repo'],
      thumbnail,
      labeler,
    });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { authorization: 'Bearer fixture' },
        payload: {
          data: Buffer.from('not decoded intentionally').toString('base64'),
          source: 'photo',
          ocrText: 'Referto privato',
          clientId: randomUUID(),
        },
      });
      expect(r.statusCode).toBe(422);
      expect(create).not.toHaveBeenCalled();
      expect(thumbnail).not.toHaveBeenCalled();
      expect(labeler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
