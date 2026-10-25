import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BrainService,
  createBrainIndex,
  createBrainService,
  resourcePath,
} from '@ernie/brain';
import { loadConfig } from '@ernie/config';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createLogger } from '@ernie/observability';
import { createRecipeRepository } from '@ernie/tools';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrainResourceSync, resourceTextLinks, withResourceSync } from './brain-resources.js';
import { createMediaRepository } from './media.js';
import { buildServer } from './server.js';

it('restituisce il salvataggio confermato anche mentre la proiezione Brain è bloccata', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const logger = { warn: vi.fn() };
  const sync = createBrainResourceSync({
    pool: {
      connect: async () => {
        entered.resolve();
        await release.promise;
        throw new Error('proiezione temporaneamente non disponibile');
      },
    } as unknown as Pool,
    brain: {} as BrainService,
    logger,
  });
  const saved = { recipe: { id: 'saved', version: 1 }, created: true };
  const repo = withResourceSync(
    { save: vi.fn(async (_u: string) => saved) },
    ['save'],
    sync.afterChange,
  );
  let result: unknown;
  const pending = repo.save('user').then((value) => {
    result = value;
  });
  try {
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result).toEqual(saved);
  } finally {
    release.resolve();
    await pending;
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
  }
});

it('non collega omonimi, parole parziali o luoghi impliciti', () => {
  const node = (path: string, title: string) => ({
    path,
    title,
    note_type: 'luogo',
    lat: null,
    lon: null,
  });
  expect(
    resourceTextLinks('Foto a Casa Anna e Roma', [
      node('a', 'Casa Anna'),
      node('b', 'Roma'),
      node('c', 'Roma'),
      node('d', 'Anna Maria'),
    ]),
  ).toEqual(['a']);
  expect(resourceTextLinks('Panorama', [node('b', 'Roma')])).toEqual([]);
});
const OWNER = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP = process.env.APP_DB_PASSWORD;
describe.skipIf(!OWNER || !APP)('risorse Brain: SQL reale, Git e API', () => {
  let owner: Pool, pool: Pool, dir: string, user: string, other: string;
  let brain: ReturnType<typeof createBrainService>,
    sync: ReturnType<typeof createBrainResourceSync>;
  let recipes: ReturnType<typeof createRecipeRepository>,
    media: ReturnType<typeof createMediaRepository>;
  let allowed = true;
  const users: string[] = [];
  const logger = createLogger({ name: 'resource-test', level: 'silent' });
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER as string, max: 2 });
    const url = new URL(OWNER as string);
    url.username = 'ernie_app';
    url.password = APP as string;
    pool = createPool({ connectionString: url.toString(), max: 8 });
    dir = await mkdtemp(join(tmpdir(), 'ernie-resources-'));
  });
  beforeEach(async () => {
    user = randomUUID();
    other = randomUUID();
    users.push(user, other);
    allowed = true;
    await owner.query(
      "INSERT INTO users(id,display_name) VALUES($1,'Resources A'),($2,'Resources B')",
      [user, other],
    );
    brain = createBrainService({
      baseDir: dir,
      index: createBrainIndex(pool, null),
      canUseResource: async (_u, k) => k !== 'recipe' || allowed,
    });
    sync = createBrainResourceSync({
      pool,
      brain,
      logger,
      canUse: async (_u, k) => k !== 'recipe' || allowed,
    });
    recipes = createRecipeRepository(pool);
    media = createMediaRepository(pool);
  });
  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await pool.end();
    await owner.end();
    await rm(dir, { recursive: true, force: true });
  });
  const photo = (title: string, location?: { lat: number; lon: number; capturedAt?: string }) => ({
    clientId: randomUUID(),
    image: Buffer.from(randomUUID()),
    thumbnail: Buffer.from('thumb'),
    width: 2,
    height: 2,
    title,
    source: 'library' as const,
    ocrText: '',
    autoOrganize: false,
    ...(location ? { location } : {}),
  });
  const queued = async () =>
    withUser(pool, user, async (c) =>
      Number(
        (await c.query('SELECT count(*) FROM brain_resource_queue WHERE user_id=$1', [user]))
          .rows[0].count,
      ),
    );
  async function drain() {
    for (let i = 0; i < 5 && (await queued()); i++) await sync.syncUser(user);
    expect(await queued()).toBe(0);
  }
  async function server() {
    return buildServer({
      config: loadConfig({
        DATABASE_URL: 'postgres://x:x@localhost/x',
        REDIS_URL: 'redis://localhost',
      }),
      logger,
      checks: {},
      brain: {
        brain,
        resources: sync,
        pool,
        allowedOrigins: [],
        authenticator: {
          authenticate: async (key) =>
            key
              ? {
                  userId: key === 'other' ? other : user,
                  apiKeyId: randomUUID(),
                  role: 'owner',
                  scopes: key === 'no-scope' ? [] : ['chat'],
                  companionName: 'Ernie',
                  settings: {},
                }
              : null,
        },
      },
    });
  }
  it('rende ricercabili dati esistenti, titoli stabili, ingredienti/OCR, senza duplicare la fonte', async () => {
    const place = await brain.write(user, {
      title: 'Casa di Anna',
      type: 'luogo',
      body: 'Una casa.',
    });
    const recipe = (
      await recipes.save(user, {
        title: 'Burritos',
        ingredients: ['200g tempeh'],
        steps: ['Cuoci'],
        notes: 'Cena a Casa di Anna',
      })
    ).recipe;
    const image = (
      await media.create(user, { ...photo('Cena a Casa di Anna'), ocrText: 'Peperoncino' })
    ).item;
    await drain();
    const rp = resourcePath({ kind: 'recipe', id: recipe.id }),
      mp = resourcePath({ kind: 'media', id: image.id });
    expect((await brain.read(user, rp))?.note.links).toContain(place.path);
    expect((await brain.read(user, place.path))?.related?.map((n) => n.path)).toEqual(
      expect.arrayContaining([rp, mp]),
    );
    expect((await brain.search(user, { query: 'tempeh' })).map((n) => n.path)).toContain(rp);
    expect((await brain.search(user, { query: 'Peperoncino' })).map((n) => n.path)).toContain(mp);
    await media.update(
      user,
      image.id,
      { title: 'Nuovo titolo', description: '', category: 'Foto', tags: [] },
      image.version,
    );
    await drain();
    expect((await brain.read(user, mp))?.note.title).toBe('Nuovo titolo');
    expect(await brain.list(user, { type: 'immagine' })).toHaveLength(1);
    await sync.syncUser(user);
    expect((await recipes.browse(user)).total).toBe(1);
    expect((await brain.reviewSnapshot(user)).notes.some((n) => [rp, mp].includes(n.path))).toBe(
      false,
    );
  });
  it('collega GPS a un luogo esistente o crea un nodo, senza fondere luoghi vicini ambigui', async () => {
    const home = await brain.write(user, {
      title: 'Casa Anna',
      type: 'luogo',
      body: 'Ingresso.',
      coords: [45, 13],
    });
    const a = (await media.create(user, photo('Foto', { lat: 45.00001, lon: 13 }))).item;
    const b = (await media.create(user, photo('Vacanza', { lat: 46, lon: 14 }))).item;
    await drain();
    expect(
      (await brain.read(user, resourcePath({ kind: 'media', id: a.id })))?.note.links,
    ).toContain(home.path);
    const places = await brain.list(user, { type: 'luogo' });
    expect(places).toHaveLength(2);
    const newPlace = places.find((n) => n.path !== home.path);
    if (!newPlace) throw new Error('Luogo mancante');
    expect(newPlace?.coords).toEqual([46, 14]);
    // Titolo neutro: le coordinate restano solo nei metadati della scheda.
    expect(newPlace.title).toMatch(/^Luogo fotografato il \d{1,2} \p{L}+ \d{4}$/u);
    expect(newPlace.title).not.toContain('46');
    expect(
      (await brain.read(user, newPlace.path))?.related?.some((n) => n.resource?.id === b.id),
    ).toBe(true);
    expect((await brain.reviewSnapshot(user)).notes.map((n) => n.path)).not.toContain(
      newPlace.path,
    );
    await brain.write(user, {
      title: 'Casa vicina',
      type: 'luogo',
      body: 'Altra casa.',
      coords: [45.00002, 13],
    });
    await drain();
    const ambiguous = (await brain.read(user, resourcePath({ kind: 'media', id: a.id })))?.note;
    if (!ambiguous) throw new Error('Foto mancante');
    expect(ambiguous.links).not.toContain(home.path);
    expect(ambiguous.body).toContain('Luogo da confermare');
    await sync.setLinks(user, { kind: 'media', id: a.id }, [home.path]);
    await drain();
    expect((await brain.read(user, resourcePath({ kind: 'media', id: a.id })))?.note.place).toBe(
      'Casa Anna',
    );
    // Cancellata l'unica foto, il luogo creato dalla sua posizione sparisce; quelli dell'utente restano.
    await media.remove(user, b.id);
    await media.remove(user, a.id);
    await drain();
    expect(await brain.read(user, newPlace.path)).toBeNull();
    expect(await brain.read(user, home.path)).not.toBeNull();
  });
  it('dà titoli distinti ai luoghi fotografati lo stesso giorno e conserva quelli completati dall’utente', async () => {
    const shot = '2026-07-02T08:00:00Z';
    const a = (await media.create(user, photo('Mare', { lat: 40, lon: 15, capturedAt: shot })))
      .item;
    const b = (await media.create(user, photo('Monte', { lat: 41, lon: 16, capturedAt: shot })))
      .item;
    await drain();
    const titles = (await brain.list(user, { type: 'luogo' })).map((n) => n.title).sort();
    expect(titles).toEqual([
      'Luogo fotografato il 2 luglio 2026',
      'Luogo fotografato il 2 luglio 2026 (2)',
    ]);
    const places = await brain.list(user, { type: 'luogo' });
    // L'utente completa una scheda: resta anche senza foto.
    for (const p of places)
      await brain.write(user, {
        title: p.title,
        type: 'luogo',
        mode: 'append',
        body: 'Ci torniamo ogni estate.',
      });
    await media.remove(user, a.id);
    await media.remove(user, b.id);
    await drain();
    expect(await brain.list(user, { type: 'luogo' })).toHaveLength(2);
  });
  it('una nuova scheda rimette in coda solo le risorse che la citano o le foto vicine', async () => {
    await recipes.save(user, {
      title: 'Torta',
      ingredients: ['farina'],
      notes: 'Per la nonna Pina',
    });
    await media.create(user, photo('Paesaggio', { lat: 44, lon: 11 }));
    await media.create(user, photo('Cena da Pina'));
    await drain();
    await brain.write(user, { title: 'Argomento estraneo', type: 'argomento', body: 'Altro.' });
    expect(await queued()).toBe(0);
    await brain.write(user, { title: 'Nonna Pina', type: 'persona', body: 'Nonna.' });
    // Solo la ricetta la cita per intero; «Pina» da sola non basta.
    expect(await queued()).toBe(1);
    await drain();
    await brain.write(user, {
      title: 'Rifugio',
      type: 'luogo',
      body: 'Baita.',
      coords: [44.0005, 11],
    });
    expect(await queued()).toBe(1);
    await drain();
  });
  it('un job che fallisce sempre va in fondo con attesa crescente senza bloccare gli altri', async () => {
    const bad = (await recipes.save(user, { title: 'Rotta', ingredients: ['sale'] })).recipe;
    const good = (await recipes.save(user, { title: 'Buona', ingredients: ['olio'] })).recipe;
    const original = brain.projectResource.bind(brain);
    const spy = vi
      .spyOn(brain, 'projectResource')
      .mockImplementation(async (u, resource, input) => {
        if (resource.id === bad.id) throw new Error('Git indisponibile');
        return original(u, resource, input);
      });
    try {
      await expect(sync.syncUser(user)).rejects.toThrow('Git indisponibile');
      expect(
        (await brain.read(user, resourcePath({ kind: 'recipe', id: good.id })))?.note.title,
      ).toBe('Buona');
      const retry = async () =>
        (
          await owner.query<{ attempts: number; waiting: boolean }>(
            'SELECT attempts, next_attempt_at > now() AS waiting FROM brain_resource_queue WHERE user_id=$1',
            [user],
          )
        ).rows;
      expect(await retry()).toEqual([{ attempts: 1, waiting: true }]);
      // In attesa: una nuova passata non lo riprova e non fallisce.
      await sync.syncUser(user);
      expect(await retry()).toEqual([{ attempts: 1, waiting: true }]);
      expect(
        (await owner.query('SELECT 1 FROM brain_resource_pending_users() WHERE user_id=$1', [user]))
          .rowCount,
      ).toBe(0);
      await owner.query('UPDATE brain_resource_queue SET next_attempt_at=now() WHERE user_id=$1', [
        user,
      ]);
      await expect(sync.syncUser(user)).rejects.toThrow('Git indisponibile');
      const delays = await owner.query<{ s: number }>(
        'SELECT extract(epoch FROM next_attempt_at - now())::int AS s FROM brain_resource_queue WHERE user_id=$1',
        [user],
      );
      expect(delays.rows[0]?.s).toBeGreaterThan(45);
    } finally {
      spy.mockRestore();
    }
    // Una modifica dell'utente lo rende subito ritentabile.
    await recipes.save(user, { title: 'Rotta', ingredients: ['sale', 'pepe'] });
    await drain();
    expect(
      (await brain.read(user, resourcePath({ kind: 'recipe', id: bad.id })))?.note.body,
    ).toContain('pepe');
  });
  it('recupera GPS da un nuovo invio identico, conserva immagini distinte e collega concetti aggiunti dopo', async () => {
    const input = photo('Vacanza a Trento');
    const first = (await media.create(user, input)).item;
    await drain();
    const location = { lat: 46.06, lon: 11.12 };
    const retried = await media.create(user, { ...input, location });
    expect(retried.created).toBe(false);
    expect(retried.item.id).toBe(first.id);
    expect(retried.item.location).toEqual(location);
    const second = (await media.create(user, photo('Seconda foto', { lat: 46.06001, lon: 11.12 })))
      .item;
    await drain();
    expect(await brain.list(user, { type: 'luogo' })).toHaveLength(1);
    const topic = await brain.write(user, { title: 'Vacanza', type: 'progetto', body: 'Viaggio.' });
    await drain();
    expect(
      (await brain.read(user, resourcePath({ kind: 'media', id: first.id })))?.note.links,
    ).toContain(topic.path);
    await media.remove(user, first.id);
    await drain();
    expect(await brain.read(user, resourcePath({ kind: 'media', id: first.id }))).toBeNull();
    expect(await brain.read(user, resourcePath({ kind: 'media', id: second.id }))).not.toBeNull();
  });
  it('recupera un errore Git e una modifica concorrente senza perdere o duplicare dati', async () => {
    const r = (await recipes.save(user, { title: 'Pasta', ingredients: ['pomodoro'] })).recipe;
    const original = brain.projectResource.bind(brain);
    const spy = vi
      .spyOn(brain, 'projectResource')
      .mockRejectedValueOnce(new Error('Git indisponibile'));
    await expect(sync.syncUser(user)).rejects.toThrow('Git indisponibile');
    expect(await queued()).toBe(1);
    // Il job fallito aspetta il prossimo tentativo: qui lo si rende subito dovuto.
    await owner.query('UPDATE brain_resource_queue SET next_attempt_at=now() WHERE user_id=$1', [
      user,
    ]);
    spy.mockImplementationOnce(async (...args) => {
      await recipes.save(user, { title: 'Pasta', ingredients: ['zucchine'] });
      return original(...args);
    });
    await sync.syncUser(user);
    expect(await queued()).toBe(1);
    spy.mockRestore();
    await drain();
    expect(
      (await brain.read(user, resourcePath({ kind: 'recipe', id: r.id })))?.note.body,
    ).toContain('zucchine');
    expect((await recipes.browse(user)).total).toBe(1);
  });
  it('protegge proprietario, controlli Ricette e pagine gestite; cancellazione elimina solo la proiezione', async () => {
    const place = await brain.write(user, { title: 'Casa', type: 'luogo', body: 'Casa.' });
    const hidden = await brain.write(user, {
      title: 'Segreto',
      type: 'persona',
      body: 'Privato',
      private: true,
    });
    const r = (
      await withResourceSync(recipes, ['save', 'remove'], sync.afterChange).save(user, {
        title: 'Cena',
        ingredients: ['riso'],
        notes: 'Casa',
      })
    ).recipe;
    const ref = { kind: 'recipe' as const, id: r.id },
      path = resourcePath(ref);
    await sync.syncUser(user);
    await expect(brain.write(user, { title: 'Cena', body: 'overwrite' })).rejects.toMatchObject({
      code: 'managed_resource',
    });
    await expect(brain.update(user, path, { body: 'overwrite' })).rejects.toMatchObject({
      code: 'managed_resource',
    });
    await expect(brain.remove(user, path)).rejects.toMatchObject({ code: 'managed_resource' });
    await expect(sync.setLinks(user, ref, [hidden.path])).rejects.toMatchObject({
      code: 'invalid_link',
    });
    expect(await sync.setLinks(other, ref, [place.path])).toBeNull();
    const app = await server();
    try {
      const url = `/v1/brain/note?path=${encodeURIComponent(path)}`;
      const response = await app.inject({ url, headers: { authorization: 'Bearer mine' } });
      expect(response.statusCode).toBe(200);
      expect(
        (await app.inject({ url, headers: { authorization: 'Bearer no-scope' } })).statusCode,
      ).toBe(403);
      expect(response.json().note.resource).toEqual(ref);
      expect(response.json().related.map((n: { path: string }) => n.path)).toContain(place.path);
      expect(
        (await app.inject({ url, headers: { authorization: 'Bearer other' } })).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/v1/brain/resources/recipe/${r.id}/links`,
            headers: { authorization: 'Bearer mine' },
            payload: { paths: [place.path] },
          })
        ).statusCode,
      ).toBe(200);
      allowed = false;
      expect(
        (await app.inject({ url, headers: { authorization: 'Bearer mine' } })).statusCode,
      ).toBe(404);
      expect(await brain.search(user, { query: 'riso' })).toEqual([]);
      expect(await brain.list(user, { type: 'ricetta' })).toEqual([]);
      allowed = true;
      await recipes.remove(user, r.id);
      await drain();
      expect(await brain.read(user, path)).toBeNull();
      expect(await brain.read(user, place.path)).not.toBeNull();
      expect((await brain.read(user, place.path))?.related).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
