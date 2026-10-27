import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { createContentReaderDiagnostics, readerFailure } from './content-readers.js';
import { contentReaderRoutes } from './routes/content-readers.js';

function setup() {
  let clock = Date.parse('2026-10-27T12:00:00Z');
  const values = new Map<string, string>();
  const diagnostics = createContentReaderDiagnostics(
    {
      read: async (u, r) => values.get(`${u}:${r}`) ?? null,
      write: async (u, r, v) => {
        values.set(`${u}:${r}`, v);
      },
    },
    { video: true },
    () => clock,
  );
  return {
    values,
    diagnostics,
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}
const auth = (id: string, scopes = ['chat']): AuthContext => ({
  userId: id,
  apiKeyId: 'key',
  scopes,
  role: 'owner',
  companionName: 'Ernie',
  settings: {},
});
describe('diagnostica lettori per account', () => {
  it('configurazione non prova una lettura; scadenza e isolamento per utente', async () => {
    const s = setup();
    expect((await s.diagnostics.report('a')).readers.every((r) => r.lastAttempt === null)).toBe(
      true,
    );
    await s.diagnostics.record(
      'a',
      'youtube_video',
      'credits',
      'Credito insufficiente.',
      s.clock() - 42,
    );
    expect(
      (await s.diagnostics.report('a')).readers.find((r) => r.id === 'youtube_video')?.lastAttempt,
    ).toMatchObject({ outcome: 'credits', durationMs: 42 });
    expect((await s.diagnostics.report('b')).readers.every((r) => r.lastAttempt === null)).toBe(
      true,
    );
    s.advance(86_400_001);
    expect((await s.diagnostics.report('a')).readers.every((r) => r.lastAttempt === null)).toBe(
      true,
    );
  });
  it('errori provider non finiscono nel pannello e Redis guasto non cambia l’esito del tool', async () => {
    expect(readerFailure({ code: 'video_rate_limited' }).outcome).toBe('rate_limited');
    expect(readerFailure({ code: 'video_service_error' }).outcome).toBe('error');
    expect(readerFailure({ code: 'video_service_auth' }).outcome).toBe('blocked');
    expect(
      readerFailure(new Error('secret https://private.invalid?api_key=secret')).message,
    ).not.toContain('secret');
    const d = createContentReaderDiagnostics(
      {
        read: async () => {
          throw Error('offline');
        },
        write: async () => {
          throw Error('offline');
        },
      },
      { video: false },
    );
    await expect(
      d.record('a', 'youtube_video', 'error', 'Servizio non raggiungibile.', Date.now()),
    ).resolves.toBeUndefined();
    expect((await d.report('a')).readers.every((r) => r.lastAttempt === null)).toBe(true);
  });
  it('rifiuta stato corrotto; scope chat e identità imposti dal server, senza probe', async () => {
    const s = setup();
    s.values.set('a:youtube_video', '{"message":"secret"}');
    const app = Fastify();
    await app.register(contentReaderRoutes, {
      authenticator: {
        authenticate: async (key) =>
          key === 'a-key'
            ? auth('a')
            : key === 'b-key'
              ? auth('b')
              : key === 'restricted'
                ? auth('a', [])
                : null,
      },
      allowedOrigins: [],
      diagnostics: s.diagnostics,
    });
    await s.diagnostics.record(
      'a',
      'youtube_captions',
      'success',
      'Testo pubblico letto.',
      s.clock(),
    );
    expect((await app.inject({ url: '/v1/content-readers' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v1/content-readers',
          headers: { authorization: 'Bearer restricted' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/v1/content-readers?userId=a',
          headers: { authorization: 'Bearer b-key' },
        })
      ).statusCode,
    ).toBe(400);
    const b = await app.inject({
      url: '/v1/content-readers',
      headers: { authorization: 'Bearer b-key' },
    });
    expect(b.statusCode).toBe(200);
    expect(b.headers['cache-control']).toBe('no-store');
    expect(b.json().readers.every((r: { lastAttempt: unknown }) => r.lastAttempt === null)).toBe(
      true,
    );
    const a = await app.inject({
      url: '/v1/content-readers',
      headers: { authorization: 'Bearer a-key' },
    });
    expect(
      a.json().readers.find((r: { id: string }) => r.id === 'youtube_captions').lastAttempt.outcome,
    ).toBe('success');
    expect(a.body).not.toContain('secret');
    await app.close();
  });
});
