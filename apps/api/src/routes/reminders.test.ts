import { randomUUID } from 'node:crypto';
import type { Reminder, ReminderStore } from '@ernie/skills';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth.js';
import { remindersRoutes } from './reminders.js';

const userId = randomUUID(),
  id = randomUUID();
async function app() {
  const reminder: Reminder = {
    id,
    text: 'Workshop',
    at: new Date('2099-01-01T10:00:00Z'),
    status: 'scheduled',
    location: 'Via Roma 3',
    url: 'https://meet.example.test/a?key=x&lang=it',
    notes: 'Porta il portatile',
  };
  const store: ReminderStore = {
    create: vi.fn(),
    list: async () => [reminder],
    remove: vi.fn(),
    update: vi.fn(async () => reminder),
  };
  const server = Fastify();
  await remindersRoutes(server, {
    allowedOrigins: [],
    store,
    authenticator: {
      authenticate: async (token) =>
        token === 'key'
          ? ({
              userId,
              apiKeyId: randomUUID(),
              scopes: ['chat'],
              role: 'owner',
              companionName: 'Ernie',
              settings: {},
            } as AuthContext)
          : null,
    },
  });
  return { server, store };
}
describe('REST dettagli promemoria', () => {
  it('legge dettagli e PATCH distingue omissione e cancellazione', async () => {
    const { server, store } = await app();
    try {
      const list = await server.inject({
        method: 'GET',
        url: '/v1/reminders',
        headers: { authorization: 'Bearer key' },
      });
      expect(list.json().reminders[0]).toMatchObject({
        location: 'Via Roma 3',
        url: 'https://meet.example.test/a?key=x&lang=it',
        notes: 'Porta il portatile',
      });
      const patch = await server.inject({
        method: 'PATCH',
        url: `/v1/reminders/${id}`,
        headers: { authorization: 'Bearer key' },
        payload: { notes: 'Nuova nota', url: null },
      });
      expect(patch.statusCode).toBe(200);
      expect(store.update).toHaveBeenCalledWith(userId, id, { notes: 'Nuova nota', url: null });
    } finally {
      await server.close();
    }
  });
  it('rifiuta URL non web, payload vuoti, dati eccessivi e utenti non autenticati', async () => {
    const { server, store } = await app();
    try {
      for (const payload of [
        { url: 'javascript:alert(1)' },
        { url: 'file:///etc/passwd' },
        { notes: 'x'.repeat(4001) },
        { location: '' },
        {},
      ]) {
        const r = await server.inject({
          method: 'PATCH',
          url: `/v1/reminders/${id}`,
          headers: { authorization: 'Bearer key' },
          payload,
        });
        expect(r.statusCode).toBe(400);
      }
      expect(
        (
          await server.inject({
            method: 'PATCH',
            url: `/v1/reminders/${id}`,
            payload: { notes: 'X' },
          })
        ).statusCode,
      ).toBe(401);
      expect(store.update).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
