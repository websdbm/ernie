import { setTimeout as delay } from 'node:timers/promises';
import {
  type BrainResource,
  type BrainService,
  isUnnamedPhotoPlace,
  normalized,
  PHOTO_PLACE_PREFIX,
  resourcePath,
} from '@ernie/brain';
import { type Pool, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';

/** Testo iniziale dei luoghi creati da una foto: se l'utente non lo cambia, il luogo orfano si può rimuovere. */
export const PHOTO_PLACE_BODY =
  'Luogo individuato dalla posizione di scatto delle foto collegate. Puoi aggiungere qui il nome del posto, una descrizione e altre informazioni.';
/** Lotto letto in una transazione breve; ogni job ha poi transazioni proprie. */
const BATCH = 50;
/** Attesa dopo un errore: 30 s, raddoppia a ogni tentativo, al massimo 6 ore. */
const RETRY_DELAY_S = 30;
const MAX_RETRY_DELAY_S = 6 * 3600;
export interface PhotoLocation {
  lat: number;
  lon: number;
  capturedAt?: string | undefined;
  accuracy?: number | undefined;
}
type Candidate = {
  path: string;
  title: string;
  note_type: string;
  lat: number | null;
  lon: number | null;
};
type Source = {
  id: string;
  title: string;
  created_at: Date;
  brain_links: string[];
  category: string | null;
  tags: string[];
  ingredients?: string[];
  steps?: string[];
  time?: string | null;
  servings?: string | null;
  source?: string | null;
  url?: string | null;
  notes?: string | null;
  description?: string;
  ocr_text?: string;
  location?: PhotoLocation | null;
};
const plain = (s: string) =>
  s.replace(/\[\[/gu, '［［').replace(/\]\]/gu, '］］').replace(/<!--/gu, '‹!--');
export function resourceBody(kind: BrainResource['kind'], row: Source): string {
  const lines: string[] = [];
  if (row.category) lines.push(`**Categoria:** ${plain(row.category)}`);
  if (row.tags.length) lines.push(`**Tag:** ${row.tags.map(plain).join(', ')}`);
  if (kind === 'recipe') {
    if (row.time) lines.push(`**Tempo:** ${plain(row.time)}`);
    if (row.servings) lines.push(`**Porzioni:** ${plain(row.servings)}`);
    lines.push(
      `## Ingredienti\n\n${(row.ingredients ?? []).map((s) => `- ${plain(s)}`).join('\n')}`,
    );
    if (row.steps?.length)
      lines.push(
        `## Preparazione\n\n${row.steps.map((s, i) => `${i + 1}. ${plain(s)}`).join('\n')}`,
      );
    if (row.notes) lines.push(`## Note\n\n${plain(row.notes)}`);
    if (row.source) lines.push(`**Fonte:** ${plain(row.source)}`);
    if (row.url) lines.push(`**Link originale:** ${plain(row.url)}`);
  } else {
    if (row.description) lines.push(plain(row.description));
    if (row.ocr_text?.trim()) lines.push(`## Testo nell’immagine\n\n${plain(row.ocr_text.trim())}`);
  }
  return lines.join('\n\n');
}
export function photoDistance(a: PhotoLocation, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((a.lat - b.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((a.lon - b.lon) * rad) / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
/** Solo titoli completi e univoci; un tag generico non crea nuove persone o luoghi. */
export function resourceTextLinks(text: string, candidates: readonly Candidate[]): string[] {
  const haystack = ` ${normalized(text)} `;
  return candidates
    .filter(
      (n) =>
        normalized(n.title).length >= 3 &&
        candidates.filter((c) => normalized(c.title) === normalized(n.title)).length === 1 &&
        haystack.includes(` ${normalized(n.title)} `),
    )
    .map((n) => n.path);
}
export function createBrainResourceSync(opts: {
  pool: Pool;
  brain: BrainService;
  logger: Pick<Logger, 'warn'>;
  canUse?: (userId: string, kind: BrainResource['kind']) => Promise<boolean>;
}) {
  const { pool, brain } = opts;
  const active = new Map<string, Promise<void>>();
  const table = (kind: BrainResource['kind']) => (kind === 'recipe' ? 'recipes' : 'media_items');
  const exists = async (userId: string, resource: BrainResource) =>
    withUser(
      pool,
      userId,
      async (c) =>
        (
          await c.query(
            `SELECT id FROM ${table(resource.kind)} WHERE user_id=$1 AND id=$2 ${resource.kind === 'recipe' ? "AND status='active'" : ''}`,
            [userId, resource.id],
          )
        ).rowCount === 1,
    );
  type Job = { kind: BrainResource['kind']; resource_id: string; generation: string };
  const candidates = (userId: string) =>
    withUser(
      pool,
      userId,
      async (c) =>
        (
          await c.query<Candidate>(
            "SELECT path,title,note_type,lat,lon FROM brain_notes WHERE user_id=$1 AND NOT private AND note_type IN ('persona','luogo','argomento','progetto') ORDER BY path",
            [userId],
          )
        ).rows,
    );
  /** Titolo neutro e univoco: niente coordinate nel titolo (restano nei metadati della scheda). */
  const photoPlaceTitle = async (userId: string, day: Date) => {
    const base = `${PHOTO_PLACE_PREFIX} il ${new Intl.DateTimeFormat('it-IT', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Rome',
    }).format(day)}`;
    for (let n = 1; n < 100; n++) {
      const title = n === 1 ? base : `${base} (${n})`;
      // brain.write aggiunge in fondo a una scheda con lo stesso titolo: serve un titolo libero.
      if (!(await brain.read(userId, title))) return title;
    }
    return `${base} (${Date.now()})`;
  };
  /** Luoghi creati da una foto, mai rinominati né modificati, rimasti senza foto o note collegate. */
  const dropOrphanPhotoPlaces = async (userId: string, paths: readonly string[]) => {
    for (const path of paths) {
      const place = await brain.read(userId, path);
      if (
        place &&
        isUnnamedPhotoPlace(place.note) &&
        place.note.body.trim() === PHOTO_PLACE_BODY &&
        !place.related?.length &&
        !place.backlinks.length
      )
        await brain.remove(userId, place.note.path);
    }
  };
  const projectJob = async (userId: string, job: Job) => {
    const resource = { kind: job.kind, id: job.resource_id };
    // Non selezionare mai image_bytes/thumbnail_bytes: la proiezione usa soltanto metadati e OCR.
    const cols =
      job.kind === 'recipe'
        ? 'id,title,created_at,brain_links,category,tags,ingredients,steps,time,servings,source,url,notes'
        : 'id,title,created_at,brain_links,category,tags,description,ocr_text,location';
    const row = await withUser(
      pool,
      userId,
      async (c) =>
        (
          await c.query<Source>(
            `SELECT ${cols} FROM ${table(job.kind)} WHERE user_id=$1 AND id=$2 ${job.kind === 'recipe' ? "AND status='active'" : ''}`,
            [userId, resource.id],
          )
        ).rows[0],
    );
    // Luoghi a cui la foto era collegata prima di questa passata: se restano senza foto si possono togliere.
    const before =
      job.kind === 'media'
        ? ((await brain.read(userId, resourcePath(resource)))?.note.links ?? [])
        : [];
    let after: string[] = [];
    if (!row) await brain.projectResource(userId, resource, null);
    else {
      let nodes = await candidates(userId);
      const aliases = row.brain_links.some((path) => !nodes.some((n) => n.path === path))
        ? await brain.identities(userId)
        : [];
      const manual = row.brain_links
        .map(
          (path) =>
            nodes.find((n) => n.path === path)?.path ??
            aliases.find((n) => n.aliases.some((a) => a.path === path))?.path,
        )
        .filter((p): p is string => !!p && nodes.some((n) => n.path === p));
      let body = resourceBody(job.kind, row);
      const links = new Set([...manual, ...resourceTextLinks(`${row.title}\n${body}`, nodes)]);
      let geoPlace: Candidate | undefined;
      const location = row.location;
      if (job.kind === 'media' && location && (location.accuracy ?? 0) <= 100) {
        geoPlace = nodes.find((n) => n.note_type === 'luogo' && manual.includes(n.path));
        if (!geoPlace) {
          const nearby = nodes.filter(
            (n) =>
              n.note_type === 'luogo' &&
              n.lat !== null &&
              n.lon !== null &&
              photoDistance(location, { lat: n.lat, lon: n.lon }) <= 75,
          );
          if (nearby.length === 1) geoPlace = nearby[0];
          else if (!nearby.length) {
            const shot = location.capturedAt ? new Date(location.capturedAt) : row.created_at;
            const result = await brain.write(userId, {
              title: await photoPlaceTitle(
                userId,
                Number.isFinite(shot.getTime()) ? shot : row.created_at,
              ),
              type: 'luogo',
              source: 'foto',
              coords: [location.lat, location.lon],
              body: PHOTO_PLACE_BODY,
            });
            nodes = await candidates(userId);
            geoPlace = nodes.find((n) => n.path === result.path);
          } else
            body +=
              '\n\n**Luogo da confermare:** più luoghi salvati sono vicini alla posizione di scatto. Scegli quello corretto in Collegamenti.';
        }
        if (geoPlace) links.add(geoPlace.path);
      }
      after = [...links].sort();
      await brain.projectResource(userId, resource, {
        title: row.title,
        created: row.created_at.toISOString(),
        private: false,
        source: job.kind === 'media' ? 'foto' : 'app',
        body,
        links: after,
        // Il telefono manda l'ora di scatto in UTC: il giorno si calcola a Roma (una foto all'1:30 del 2 luglio
        // non deve finire il 1°).
        ...(location?.capturedAt
          ? {
              refersFrom: new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Rome',
              }).format(new Date(location.capturedAt)),
            }
          : {}),
        ...(location ? { coords: [location.lat, location.lon] as const } : {}),
        ...(geoPlace ? { place: geoPlace.title } : {}),
      });
    }
    const dropped = before.filter((path) => !after.includes(path));
    if (dropped.length) await dropOrphanPhotoPlaces(userId, dropped);
    // Una modifica concorrente ha una generazione nuova: rimane in coda.
    await withUser(pool, userId, (ack) =>
      ack.query(
        'DELETE FROM brain_resource_queue WHERE user_id=$1 AND kind=$2 AND resource_id=$3 AND generation=$4',
        [userId, job.kind, resource.id, job.generation],
      ),
    );
  };
  /**
   * Un solo sincronizzatore per utente anche fra processi, senza tenere aperta una transazione durante Git ed
   * embedding: lock di sessione su una connessione dedicata, rilasciato alla fine (o con la connessione).
   */
  const withUserLock = async <T>(userId: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const client = await pool.connect();
    let broken = false;
    const lockQuery = async (sql: string) => {
      try {
        return await client.query<{ ok: boolean }>(sql, [userId]);
      } catch (err) {
        broken = true;
        throw err;
      }
    };
    try {
      let locked = false;
      for (let i = 0; i < 20 && !locked; i++) {
        locked =
          (await lockQuery('SELECT pg_try_advisory_lock(hashtextextended($1,41)) AS ok')).rows[0]
            ?.ok === true;
        if (!locked) await delay(250);
      }
      // Un altro processo sta già lavorando la coda di questo utente: la riprende lui o il prossimo heartbeat.
      if (!locked) return undefined;
      try {
        return await fn();
      } finally {
        await lockQuery('SELECT pg_advisory_unlock(hashtextextended($1,41)) AS ok').catch(() => {});
      }
    } finally {
      // Una connessione con il lock forse ancora attivo non torna nel pool.
      client.release(broken);
    }
  };
  const processQueue = async (userId: string) => {
    const jobs = await withUser(
      pool,
      userId,
      async (c) =>
        (
          await c.query<Job>(
            `SELECT kind,resource_id,generation FROM brain_resource_queue
              WHERE user_id=$1 AND next_attempt_at<=now()
              ORDER BY next_attempt_at,queued_at,kind,resource_id LIMIT $2`,
            [userId, BATCH],
          )
        ).rows,
    );
    if (!jobs.length) return;
    await brain.ready(userId);
    let firstError: unknown;
    for (const job of jobs) {
      try {
        await projectJob(userId, job);
      } catch (err) {
        firstError ??= err;
        // Il job va in fondo con un'attesa crescente: gli altri della coda proseguono.
        await withUser(pool, userId, (c) =>
          c.query(
            `UPDATE brain_resource_queue SET attempts=attempts+1,
               next_attempt_at=now() + make_interval(secs => least($5::double precision, $6::double precision * 2 ^ attempts))
             WHERE user_id=$1 AND kind=$2 AND resource_id=$3 AND generation=$4`,
            [userId, job.kind, job.resource_id, job.generation, MAX_RETRY_DELAY_S, RETRY_DELAY_S],
          ),
        ).catch((ackErr: unknown) =>
          opts.logger.warn({ userId, err: ackErr }, 'risorse Brain: tentativo non registrato'),
        );
      }
    }
    if (firstError) throw firstError;
  };
  const syncUser = async (userId: string): Promise<void> => {
    // Una seconda richiesta aspetta la passata in corso, poi rilegge la coda: non perde una modifica arrivata durante il commit.
    const previous = active.get(userId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        await withUserLock(userId, () => processQueue(userId));
      });
    active.set(userId, run);
    try {
      await run;
    } finally {
      if (active.get(userId) === run) active.delete(userId);
    }
  };
  return {
    syncUser,
    /** SQL e coda sono già confermati. Git/indicizzazione non devono ritardare l'esito della scrittura. */
    async afterChange(userId: string) {
      void syncUser(userId).catch((err) => {
        opts.logger.warn({ userId, err }, 'risorse Brain in coda: sincronizzazione rinviata');
      });
    },
    async drain() {
      const users = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM brain_resource_pending_users()',
      );
      for (const { user_id } of users.rows) {
        try {
          await syncUser(user_id);
        } catch (err) {
          opts.logger.warn({ userId: user_id, err }, 'sincronizzazione risorse Brain da ritentare');
        }
      }
    },
    async links(userId: string, resource: BrainResource): Promise<string[]> {
      if (opts.canUse && !(await opts.canUse(userId, resource.kind))) return [];
      return withUser(
        pool,
        userId,
        async (c) =>
          (
            await c.query<{ brain_links: string[] }>(
              `SELECT brain_links FROM ${table(resource.kind)} WHERE user_id=$1 AND id=$2`,
              [userId, resource.id],
            )
          ).rows[0]?.brain_links ?? [],
      );
    },
    async setLinks(
      userId: string,
      resource: BrainResource,
      paths: string[],
    ): Promise<string[] | null> {
      if (opts.canUse && !(await opts.canUse(userId, resource.kind))) return null;
      if (!(await exists(userId, resource))) return null;
      const unique = [...new Set(paths)];
      for (const path of unique) {
        const result = await brain.read(userId, path);
        if (
          !result ||
          result.note.private ||
          !['persona', 'luogo', 'progetto', 'argomento'].includes(result.note.type)
        )
          throw Object.assign(
            new Error('Scegli persone, luoghi o argomenti esistenti e non riservati.'),
            { statusCode: 400, code: 'invalid_link' },
          );
      }
      const changed = await withUser(pool, userId, (c) =>
        c.query(
          `UPDATE ${table(resource.kind)} SET brain_links=$3 WHERE user_id=$1 AND id=$2 ${resource.kind === 'recipe' ? "AND status='active'" : ''}`,
          [userId, resource.id, unique],
        ),
      );
      if (!changed.rowCount) return null;
      await syncUser(userId);
      return unique;
    },
  };
}
export type BrainResourceSync = ReturnType<typeof createBrainResourceSync>;
/** Conserva il contratto del repository; ogni via di scrittura (tool e REST) aggiorna lo stesso Brain. */
export function withResourceSync<T extends object>(
  repo: T,
  methods: readonly (keyof T)[],
  sync: (userId: string) => Promise<void>,
): T {
  return new Proxy(repo, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (!methods.includes(key as keyof T) || typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(method, target, args);
        await sync(String(args[0]));
        return result;
      };
    },
  });
}
