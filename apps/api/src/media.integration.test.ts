import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '@ernie/config';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaRepository, type MediaItem } from './media.js';
import { jpegSize, mediaThumbnail } from './media-image.js';
import { buildServer } from './server.js';

function jpeg(color = 'orange') {
  return execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=64x96`,
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-f',
    'image2pipe',
    'pipe:1',
  ]);
}
const picture = jpeg();
describe('immagini Media', () => {
  it('legge dimensioni reali e produce una miniatura JPEG decodificabile', async () => {
    expect(jpegSize(picture)).toEqual({ width: 64, height: 96 });
    const prepared = await mediaThumbnail(picture);
    expect(jpegSize(prepared.thumbnail)).toEqual({ width: 64, height: 96 });
    expect(prepared.thumbnail.length).toBeLessThan(400_000);
  });
  it('rifiuta dati falsi, file troncati e dimensioni oltre il limite', async () => {
    expect(() => jpegSize(Buffer.from('<svg></svg>'))).toThrow();
    expect(() => jpegSize(picture.subarray(0, -2))).toThrow();
    const fake = Buffer.from(picture);
    const index = fake.indexOf(Buffer.from([0xff, 0xc0]));
    expect(index).toBeGreaterThan(0);
    fake.writeUInt16BE(65000, index + 5);
    await expect(mediaThumbnail(fake)).rejects.toMatchObject({ code: 'image_dimensions' });
  });
  it('rifiuta un secondo SOF con dimensioni diverse da quelle controllate', async () => {
    const index = picture.indexOf(Buffer.from([0xff, 0xc0]));
    const length = picture.readUInt16BE(index + 2);
    const sof = Buffer.from(picture.subarray(index, index + 2 + length));
    sof.writeUInt16BE(9000, 5);
    sof.writeUInt16BE(9000, 7);
    const doubled = Buffer.concat([
      picture.subarray(0, index + 2 + length),
      sof,
      picture.subarray(index + 2 + length),
    ]);
    expect(() => jpegSize(doubled)).toThrow(/leggere/);
    await expect(mediaThumbnail(doubled)).rejects.toMatchObject({ code: 'invalid_image' });
    // Un SOF senza tipo supportato (lossless, aritmetico) non passa per l'unico controllato.
    const lossless = Buffer.from(picture);
    lossless[index + 1] = 0xc3;
    expect(() => jpegSize(lossless)).toThrow();
  });
});
const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
describe.skipIf(!OWNER_URL || !APP_PASSWORD)('raccolta Media: REST, PostgreSQL e RLS', () => {
  let owner: Pool, appPool: Pool;
  let repo: ReturnType<typeof createMediaRepository>;
  const a = randomUUID(),
    b = randomUUID();
  const headers = { authorization: 'Bearer media-a' };
  const labels = {
    title: 'Caffè sul tavolo',
    description: 'Una foto di prova.',
    category: 'Casa',
    tags: ['caffè', 'prova'],
  };
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const url = new URL(OWNER_URL as string);
    url.username = 'ernie_app';
    url.password = APP_PASSWORD as string;
    appPool = createPool({ connectionString: url.toString(), max: 4 });
    repo = createMediaRepository(appPool);
    await owner.query(
      "INSERT INTO users(id,display_name) VALUES($1,'Media test A'),($2,'Media test B')",
      [a, b],
    );
  });
  beforeEach(async () => {
    await owner.query('DELETE FROM media_items WHERE user_id=ANY($1::uuid[])', [[a, b]]);
  });
  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[a, b]]);
    await owner.end();
    await appPool.end();
  });
  async function setup(labeler = vi.fn().mockResolvedValue(labels)) {
    const app = await buildServer({
      config: loadConfig({
        DATABASE_URL: 'postgres://x:x@localhost/x',
        REDIS_URL: 'redis://localhost',
      }),
      logger: createLogger({ name: 'media-test', level: 'silent' }),
      checks: {},
      media: {
        repo,
        labeler,
        allowedOrigins: ['https://allowed.example'],
        authenticator: {
          authenticate: async (key) =>
            ['media-a', 'media-b', 'no-scope'].includes(key ?? '')
              ? {
                  userId: key === 'media-b' ? b : a,
                  apiKeyId: randomUUID(),
                  scopes: key === 'no-scope' ? [] : ['chat'],
                  role: 'owner',
                  companionName: 'Ernie',
                  settings: {},
                }
              : null,
        },
      },
    });
    return { app, labeler };
  }
  function upload(data = picture, clientId = randomUUID(), autoOrganize = true) {
    return {
      clientId,
      data: data.toString('base64'),
      source: 'library',
      ocrText: 'caffè 100% _ prova',
      autoOrganize,
    };
  }
  it('autorizza proprietario e origine; protegge anche file e metadati', async () => {
    const { app } = await setup();
    try {
      expect((await app.inject('/v1/media')).statusCode).toBe(401);
      expect(
        (await app.inject({ url: '/v1/media', headers: { authorization: 'Bearer no-scope' } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/v1/media',
            headers: { ...headers, origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(403);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers,
        payload: upload(),
      });
      expect(created.statusCode).toBe(201);
      const item = created.json().item as MediaItem;
      for (const path of [
        `/v1/media/${item.id}`,
        `/v1/media/${item.id}/image`,
        `/v1/media/${item.id}/image?size=thumbnail`,
      ]) {
        expect(
          (await app.inject({ url: path, headers: { authorization: 'Bearer media-b' } }))
            .statusCode,
        ).toBe(404);
      }
      for (const method of ['PATCH', 'DELETE'] as const) {
        expect(
          (
            await app.inject({
              method,
              url: `/v1/media/${item.id}`,
              headers: { authorization: 'Bearer media-b' },
              ...(method === 'PATCH' ? { payload: { ...labels, version: item.version } } : {}),
            })
          ).statusCode,
        ).toBe(404);
      }
      const binary = await app.inject({ url: `/v1/media/${item.id}/image`, headers });
      expect(binary.headers['content-type']).toBe('image/jpeg');
      expect(binary.headers['cache-control']).toBe('no-store');
      expect(binary.headers['x-content-type-options']).toBe('nosniff');
      expect(createHash('sha256').update(binary.rawPayload).digest('hex')).toBe(
        createHash('sha256').update(picture).digest('hex'),
      );
      expect(
        await withUser(
          appPool,
          b,
          async (c) => (await c.query('SELECT id FROM media_items WHERE id=$1', [item.id])).rows,
        ),
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it('retry e doppio caricamento conservano un solo record e una sola analisi', async () => {
    const { app, labeler } = await setup();
    try {
      const body = upload();
      const first = (
        await app.inject({ method: 'POST', url: '/v1/media', headers, payload: body })
      ).json().item as MediaItem;
      const edited = await app.inject({
        method: 'PATCH',
        url: `/v1/media/${first.id}`,
        headers,
        payload: { ...labels, title: 'Titolo scelto da me', version: first.version },
      });
      expect(edited.statusCode).toBe(200);
      for (const payload of [body, upload()]) {
        const retry = await app.inject({ method: 'POST', url: '/v1/media', headers, payload });
        expect(retry.statusCode).toBe(200);
        expect(retry.json().item.id).toBe(first.id);
        expect(retry.json().item.title).toBe('Titolo scelto da me');
      }
      expect(labeler).toHaveBeenCalledTimes(1);
      expect((await repo.browse(a, { offset: 0, limit: 10 })).total).toBe(1);
      const mismatch = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers,
        payload: upload(jpeg('blue'), body.clientId),
      });
      expect(mismatch.statusCode).toBe(409);
      const others = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers: { authorization: 'Bearer media-b' },
        payload: body,
      });
      expect(others.statusCode).toBe(201);
      expect(others.json().item.id).not.toBe(first.id);
    } finally {
      await app.close();
    }
  });
  it('ricerca testo OCR, accenti, tag, categoria e anno; pagine senza repliche', async () => {
    const { app } = await setup();
    try {
      for (const color of ['orange', 'blue', 'green'])
        await app.inject({
          method: 'POST',
          url: '/v1/media',
          headers,
          payload: upload(jpeg(color)),
        });
      for (const q of ['caffe', '100%', '_']) {
        const result = await app.inject({
          url: `/v1/media?q=${encodeURIComponent(q)}&category=Casa&tag=caff%C3%A8&year=${new Date().getFullYear()}`,
          headers,
        });
        expect(result.statusCode).toBe(200);
        expect(result.json().total).toBe(3);
      }
      const one = (await app.inject({ url: '/v1/media?limit=2', headers })).json();
      const two = (await app.inject({ url: '/v1/media?limit=2&offset=2', headers })).json();
      expect(new Set([...one.items, ...two.items].map((v: MediaItem) => v.id)).size).toBe(3);
      expect(one.categories).toEqual([{ value: 'Casa', count: 3 }]);
      const other = (
        await app.inject({ url: '/v1/media', headers: { authorization: 'Bearer media-b' } })
      ).json();
      expect(other.items).toEqual([]);
      expect(other.tags).toEqual([]);
      expect(other.years).toEqual([]);
      expect((await app.inject({ url: '/v1/media?limit=0', headers })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('una modifica manuale vince su un risultato automatico tardivo', async () => {
    const labeler = vi.fn(async ({ id }: { id: string }) => {
      await repo.update(a, id, { ...labels, title: 'La mia scelta' }, 1);
      return labels;
    });
    const { app } = await setup(labeler);
    try {
      const saved = await app.inject({
        method: 'POST',
        url: '/v1/media',
        headers,
        payload: upload(),
      });
      expect(saved.json().item.title).toBe('La mia scelta');
      expect(saved.json().item.organization).toBe('manual');
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/v1/media/${saved.json().item.id}`,
            headers,
            payload: { ...labels, version: 1 },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('un errore del modello conserva la foto, il modo manuale non lo chiama; cancellazione circoscritta', async () => {
    const { app, labeler } = await setup(vi.fn().mockRejectedValue(new Error('budget')));
    try {
      const first = (
        await app.inject({ method: 'POST', url: '/v1/media', headers, payload: upload() })
      ).json().item;
      expect(first.organization).toBe('failed');
      const second = (
        await app.inject({
          method: 'POST',
          url: '/v1/media',
          headers,
          payload: upload(jpeg('blue'), randomUUID(), false),
        })
      ).json().item;
      expect(second.organization).toBe('manual');
      expect(labeler).toHaveBeenCalledTimes(1);
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/media/${first.id}`, headers })).statusCode,
      ).toBe(204);
      expect((await app.inject({ url: `/v1/media/${first.id}/image`, headers })).statusCode).toBe(
        404,
      );
      expect((await repo.browse(a, { offset: 0, limit: 10 })).items.map((i) => i.id)).toEqual([
        second.id,
      ]);
    } finally {
      await app.close();
    }
  });
  it('caricamenti concorrenti identici producono una sola nuova immagine', async () => {
    const prepared = await mediaThumbnail(picture);
    const input = {
      ...prepared,
      image: picture,
      source: 'photo' as const,
      title: 'Una sola',
      ocrText: '',
      autoOrganize: false,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.create(a, { ...input, clientId: randomUUID() })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
  });
  it('rifiuta URL, base64 non canonico e immagini contraffatte senza scrivere', async () => {
    const { app } = await setup();
    try {
      for (const data of [
        'https://example.com/photo.jpg',
        Buffer.from('<svg><script>bad</script></svg>').toString('base64'),
        `${picture.toString('base64')}!`,
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/media',
              headers,
              payload: { ...upload(), data },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect((await repo.browse(a, { offset: 0, limit: 10 })).total).toBe(0);
    } finally {
      await app.close();
    }
  });
});
