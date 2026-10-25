import { type BrainResource, type BrainService, normalized } from '@ernie/brain';
import { type Pool, withUser } from '@ernie/db';
import type { Logger } from '@ernie/observability';

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
  const syncUser = async (userId: string): Promise<void> => {
    // Una seconda richiesta aspetta la passata in corso, poi rilegge la coda: non perde una modifica arrivata durante il commit.
    const previous = active.get(userId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        await withUser(pool, userId, async (c) => {
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,41))', [userId]);
          const jobs = await c.query<{
            kind: BrainResource['kind'];
            resource_id: string;
            generation: string;
          }>(
            'SELECT kind,resource_id,generation FROM brain_resource_queue WHERE user_id=$1 ORDER BY queued_at,kind,resource_id LIMIT 100',
            [userId],
          );
          if (!jobs.rows.length) return;
          await brain.ready(userId);
          for (const job of jobs.rows) {
            const resource = { kind: job.kind, id: job.resource_id };
            // Non selezionare mai image_bytes/thumbnail_bytes: la proiezione usa soltanto metadati e OCR.
            const cols =
              job.kind === 'recipe'
                ? 'id,title,created_at,brain_links,category,tags,ingredients,steps,time,servings,source,url,notes'
                : 'id,title,created_at,brain_links,category,tags,description,ocr_text,location';
            const row = (
              await c.query<Source>(
                `SELECT ${cols} FROM ${table(job.kind)} WHERE user_id=$1 AND id=$2 ${job.kind === 'recipe' ? "AND status='active'" : ''}`,
                [userId, resource.id],
              )
            ).rows[0];
            if (!row) await brain.projectResource(userId, resource, null);
            else {
              const candidates = async () =>
                (
                  await c.query<Candidate>(
                    "SELECT path,title,note_type,lat,lon FROM brain_notes WHERE user_id=$1 AND NOT private AND note_type IN ('persona','luogo','argomento','progetto') ORDER BY path",
                    [userId],
                  )
                ).rows;
              let nodes = await candidates();
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
              const links = new Set([
                ...manual,
                ...resourceTextLinks(`${row.title}\n${body}`, nodes),
              ]);
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
                    const title = `Luogo fotografato (${location.lat.toFixed(5)}, ${location.lon.toFixed(5)})`;
                    const result = await brain.write(userId, {
                      title,
                      type: 'luogo',
                      source: 'foto',
                      coords: [location.lat, location.lon],
                      body: 'Luogo individuato dalla posizione di scatto delle foto collegate. Puoi aggiungere qui il nome del posto, una descrizione e altre informazioni.',
                    });
                    nodes = await candidates();
                    geoPlace = nodes.find((n) => n.path === result.path);
                  } else
                    body +=
                      '\n\n**Luogo da confermare:** più luoghi salvati sono vicini alla posizione di scatto. Scegli quello corretto in Collegamenti.';
                }
                if (geoPlace) links.add(geoPlace.path);
              }
              await brain.projectResource(userId, resource, {
                title: row.title,
                created: row.created_at.toISOString(),
                private: false,
                source: job.kind === 'media' ? 'foto' : 'app',
                body,
                links: [...links].sort(),
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
            // Una modifica concorrente ha una generazione nuova: rimane in coda.
            await withUser(pool, userId, (ack) =>
              ack.query(
                'DELETE FROM brain_resource_queue WHERE user_id=$1 AND kind=$2 AND resource_id=$3 AND generation=$4',
                [userId, job.kind, resource.id, job.generation],
              ),
            );
          }
        });
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
