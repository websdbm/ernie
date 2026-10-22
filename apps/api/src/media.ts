import { createHash } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';
import type { PhotoLocation } from './brain-resources.js';

export interface MediaItem {
  location?: PhotoLocation | null;
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  width: number;
  height: number;
  source: string;
  organization: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface MediaLabels {
  title: string;
  description: string;
  category: string;
  tags: string[];
}
export interface MediaQuery {
  q?: string | undefined;
  category?: string | undefined;
  tag?: string | undefined;
  year?: number | undefined;
  offset: number;
  limit: number;
}
export interface MediaInput {
  location?: PhotoLocation;
  clientId: string;
  image: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  title: string;
  source: 'photo' | 'scan' | 'library';
  ocrText: string;
  autoOrganize: boolean;
}
export class MediaError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const columns = `location, id, title, description, category, tags, width, height, source, organization, version,
 created_at AS "createdAt", updated_at AS "updatedAt"`;
export function mediaTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLocaleLowerCase('it')).filter(Boolean))].slice(
    0,
    10,
  );
}
export function createMediaRepository(pool: Pool) {
  return {
    async create(userId: string, input: MediaInput) {
      const hash = createHash('sha256').update(input.image).digest('hex');
      return withUser(pool, userId, async (c) => {
        // Serializza quota e deduplicazione dello stesso account, senza tenere lock durante l'AI.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 40))', [userId]);
        const existing = await c.query<MediaItem & { sha256: string; client_id: string }>(
          `SELECT ${columns}, sha256, client_id FROM media_items WHERE user_id=$1 AND (client_id=$2 OR sha256=$3)`,
          [userId, input.clientId, hash],
        );
        const conflict = existing.rows.find(
          (r) => r.client_id === input.clientId && r.sha256 !== hash,
        );
        if (conflict)
          throw new MediaError(
            409,
            'upload_conflict',
            'Questo caricamento contiene una foto diversa. Selezionala nuovamente.',
          );
        if (existing.rows[0]) {
          const { sha256: _hash, client_id: _client, ...item } = existing.rows[0];
          // Una nuova importazione dello stesso file puo recuperare EXIF assenti nel vecchio upload.
          // Non sovrascrivere una posizione gia registrata con un'altra.
          if (!item.location && input.location) {
            const refreshed = await c.query<MediaItem>(
              `UPDATE media_items SET location=$3, version=version+1, updated_at=now() WHERE user_id=$1 AND id=$2 AND location IS NULL RETURNING ${columns}`,
              [userId, item.id, JSON.stringify(input.location)],
            );
            return { item: refreshed.rows[0] ?? item, created: false };
          }
          return { item, created: false };
        }
        const quota = await c.query<{ count: number; bytes: string }>(
          'SELECT count(*)::int AS count, coalesce(sum(octet_length(image_bytes)+octet_length(thumbnail_bytes)),0)::text AS bytes FROM media_items WHERE user_id=$1',
          [userId],
        );
        const used = quota.rows[0];
        if (
          (used?.count ?? 0) >= 2000 ||
          Number(used?.bytes ?? 0) + input.image.length + input.thumbnail.length > 500_000_000
        )
          throw new MediaError(
            413,
            'media_quota',
            'La raccolta Media ha raggiunto lo spazio disponibile. Elimina alcune immagini prima di aggiungerne altre.',
          );
        const result = await c.query<MediaItem>(
          `INSERT INTO media_items
          (user_id,client_id,sha256,image_bytes,thumbnail_bytes,width,height,title,source,ocr_text,organization,category,location)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${columns}`,
          [
            userId,
            input.clientId,
            hash,
            input.image,
            input.thumbnail,
            input.width,
            input.height,
            input.title,
            input.source,
            input.ocrText,
            input.autoOrganize ? 'pending' : 'manual',
            input.source === 'scan' ? 'Documenti' : 'Foto',
            input.location ? JSON.stringify(input.location) : null,
          ],
        );
        const item = result.rows[0];
        if (!item) throw new Error('Media non salvato');
        return { item, created: true };
      });
    },
    async get(userId: string, id: string) {
      return withUser(
        pool,
        userId,
        async (c) =>
          (
            await c.query<MediaItem>(
              `SELECT ${columns} FROM media_items WHERE user_id=$1 AND id=$2`,
              [userId, id],
            )
          ).rows[0] ?? null,
      );
    },
    async image(userId: string, id: string, thumbnail: boolean) {
      return withUser(
        pool,
        userId,
        async (c) =>
          (
            await c.query<{ bytes: Buffer }>(
              `SELECT ${thumbnail ? 'thumbnail_bytes' : 'image_bytes'} AS bytes FROM media_items WHERE user_id=$1 AND id=$2`,
              [userId, id],
            )
          ).rows[0]?.bytes ?? null,
      );
    },
    async browse(userId: string, query: MediaQuery) {
      return withUser(pool, userId, async (c) => {
        const search = query.q?.trim().replace(/[\\%_]/g, '\\$&');
        const args = [
          userId,
          search ? `%${search}%` : null,
          query.category ?? null,
          query.tag ?? null,
          query.year ?? null,
        ];
        const where = `user_id=$1
          AND ($2::text IS NULL OR recipe_search_normalize(title || ' ' || description || ' ' || category || ' ' || array_to_string(tags,' ') || ' ' || ocr_text) LIKE recipe_search_normalize($2))
          AND ($3::text IS NULL OR category=$3) AND ($4::text IS NULL OR $4=ANY(tags))
          AND ($5::int IS NULL OR extract(year FROM created_at AT TIME ZONE 'Europe/Rome')=$5)`;
        const count = await c.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM media_items WHERE ${where}`,
          args,
        );
        const items = await c.query<MediaItem>(
          `SELECT ${columns} FROM media_items WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7`,
          [...args, query.limit, query.offset],
        );
        const categories = await c.query<{ value: string; count: number }>(
          'SELECT category AS value,count(*)::int AS count FROM media_items WHERE user_id=$1 GROUP BY category ORDER BY category',
          [userId],
        );
        const tags = await c.query<{ value: string; count: number }>(
          'SELECT tag AS value,count(*)::int AS count FROM media_items CROSS JOIN LATERAL unnest(tags) AS tag WHERE user_id=$1 GROUP BY tag ORDER BY count(*) DESC,tag LIMIT 100',
          [userId],
        );
        const years = await c.query<{ value: number; count: number }>(
          `SELECT extract(year FROM created_at AT TIME ZONE 'Europe/Rome')::int AS value,count(*)::int AS count FROM media_items WHERE user_id=$1 GROUP BY value ORDER BY value DESC`,
          [userId],
        );
        return {
          items: items.rows,
          total: count.rows[0]?.total ?? 0,
          offset: query.offset,
          limit: query.limit,
          categories: categories.rows,
          tags: tags.rows,
          years: years.rows,
        };
      });
    },
    async update(
      userId: string,
      id: string,
      labels: MediaLabels,
      version: number,
      automatic = false,
    ) {
      return withUser(pool, userId, async (c) => {
        const result = await c.query<MediaItem>(
          `UPDATE media_items SET title=$3,description=$4,category=$5,tags=$6,organization=$7,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2 AND version=$8 RETURNING ${columns}`,
          [
            userId,
            id,
            labels.title,
            labels.description,
            labels.category,
            mediaTags(labels.tags),
            automatic ? 'automatic' : 'manual',
            version,
          ],
        );
        if (result.rows[0]) return result.rows[0];
        const found = await c.query('SELECT id FROM media_items WHERE user_id=$1 AND id=$2', [
          userId,
          id,
        ]);
        if (found.rowCount)
          throw new MediaError(
            409,
            'version_conflict',
            'La scheda è cambiata. Riaprila prima di salvare nuovamente.',
          );
        return null;
      });
    },
    async markFailed(userId: string, id: string) {
      await withUser(pool, userId, (c) =>
        c.query(
          "UPDATE media_items SET organization='failed' WHERE user_id=$1 AND id=$2 AND organization='pending'",
          [userId, id],
        ),
      );
    },
    async remove(userId: string, id: string) {
      return withUser(
        pool,
        userId,
        async (c) =>
          (await c.query('DELETE FROM media_items WHERE user_id=$1 AND id=$2', [userId, id]))
            .rowCount !== 0,
      );
    },
  };
}
export type MediaRepository = ReturnType<typeof createMediaRepository>;
