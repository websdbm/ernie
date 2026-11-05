import { randomUUID } from 'node:crypto';
import { type Pool, type PoolClient, withUser } from '@ernie/db';
import { parseArchiveFile } from './parser.js';
import {
  type Archive,
  type ArchivePatch,
  ChatArchiveError,
  type ChatArchiveRepository,
  type Message,
  type MessageQuery,
  type ParsedArchive,
  type Preview,
} from './types.js';
import { normalizeWhatsAppPhone, normalizeWhatsAppUrl } from './whatsapp.js';

const iso = (d: unknown): string =>
  d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString();
const nullableDate = (d: unknown): string | null => (d === null || d === undefined ? null : iso(d));
const archiveOf = (r: Record<string, unknown>): Archive => ({
  id: String(r.id),
  name: String(r.name),
  kind: r.kind === 'group' ? 'group' : 'direct',
  category: r.category === null ? null : String(r.category),
  summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
  tags: r.tags as string[],
  timeZone: String(r.time_zone),
  whatsappPhone: r.whatsapp_phone as string | null,
  whatsappUrl: r.whatsapp_url as string | null,
  revision: Number(r.revision),
  indexedRevision: Number(r.indexed_revision),
  indexedAt: iso(r.indexed_at),
  lastImportedAt: iso(r.last_imported_at),
  firstMessageAt: nullableDate(r.first_message_at),
  latestMessageAt: nullableDate(r.latest_message_at),
  messageCount: Number(r.message_count),
  participantCount: Number(r.participant_count),
});
const messageOf = (r: Record<string, unknown>): Message => ({
  id: String(r.id),
  senderId: r.sender_id as string | null,
  sender: r.sender as string | null,
  at: iso(r.at),
  rawText: String(r.raw_text),
  text: String(r.body),
  type: r.message_type as Message['type'],
  position: Number(r.position),
});
const error = (status: number, code: string, message: string): never => {
  throw new ChatArchiveError(status, code, message);
};
const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value ?? fallback) : fallback));

/** Ordered occurrence matching, not set membership: intentional repeats remain distinct. */
export function reconcileMessages(
  existing: readonly { id: string; fingerprint: string }[],
  incoming: readonly { fingerprint: string }[],
): Array<string | null> {
  const positions = new Map<string, number[]>();
  existing.forEach((m, i) => {
    const p = positions.get(m.fingerprint) ?? [];
    p.push(i);
    positions.set(m.fingerprint, p);
  });
  let cursor = 0;
  return incoming.map((m) => {
    const candidates = positions.get(m.fingerprint) ?? [];
    let low = 0,
      high = candidates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((candidates[mid] ?? -1) < cursor) low = mid + 1;
      else high = mid;
    }
    const match = candidates[low];
    if (match === undefined) return null;
    cursor = match + 1;
    return existing[match]?.id ?? null;
  });
}
/** Strong contiguous overlap requires at least four ordered messages and three distinct fingerprints. */
export function overlapConfidence(
  existing: readonly { fingerprint: string }[],
  incoming: readonly { fingerprint: string }[],
): number {
  if (!existing.length || !incoming.length) return 0;
  const triples = new Map<string, number[]>();
  const key = (xs: readonly { fingerprint: string }[], i: number) =>
    `${xs[i]?.fingerprint}:${xs[i + 1]?.fingerprint}:${xs[i + 2]?.fingerprint}`;
  for (let i = 0; i < existing.length - 2; i++) {
    const k = key(existing, i),
      found = triples.get(k) ?? [];
    if (found.length < 16) found.push(i);
    triples.set(k, found);
  }
  let best = 0;
  for (let j = 0; j < incoming.length - 2; j++) {
    const start = incoming[j];
    if (!start || new Set(incoming.slice(j, j + 3).map((m) => m.fingerprint)).size < 3) continue;
    for (const i of triples.get(key(incoming, j)) ?? []) {
      let length = 3;
      while (
        i + length < existing.length &&
        j + length < incoming.length &&
        existing[i + length]?.fingerprint === incoming[j + length]?.fingerprint
      )
        length++;
      best = Math.max(best, length);
      if (best >= 8) return 0.99;
    }
  }
  return best >= 4 ? 0.96 : best >= 3 ? 0.6 : 0;
}
const bounds = (parsed: ParsedArchive) => {
  const dates = parsed.messages.map((m) => m.at).sort();
  return { firstMessageAt: dates[0] ?? null, latestMessageAt: dates.at(-1) ?? null };
};
async function getArchive(
  client: PoolClient,
  userId: string,
  id: string,
  lock: boolean | 'share' = false,
) {
  const r = await client.query(
    'SELECT * FROM chat_archives WHERE user_id=$1 AND id=$2' +
      (lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : ''),
    [userId, id],
  );
  return r.rows[0] ? archiveOf(r.rows[0]) : null;
}
async function fingerprints(client: PoolClient, userId: string, id: string, parsed: ParsedArchive) {
  const span = bounds(parsed);
  const rows = (
    await client.query<{ id: string; fingerprint: string }>(
      'SELECT id, fingerprint FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2 AND at>=$3 AND at<=$4 ORDER BY at, position LIMIT 300001',
      [userId, id, span.firstMessageAt, span.latestMessageAt],
    )
  ).rows;
  if (rows.length > 300_000)
    return error(
      413,
      'archive_comparison_too_large',
      'Questo intervallo contiene troppi messaggi già archiviati. Importa un periodo più breve.',
    );
  return rows;
}
async function previewParsed(
  client: PoolClient,
  userId: string,
  parsed: ParsedArchive,
): Promise<Preview> {
  const span = bounds(parsed);
  const archives = (
    await client.query(
      `SELECT a.* FROM chat_archives a WHERE a.user_id=$1 AND (lower(a.name)=lower($2) OR EXISTS (SELECT 1 FROM chat_archive_imports i WHERE i.user_id=$1 AND i.archive_id=a.id AND (i.file_hash=$3 OR i.text_hash=$4)) OR (a.first_message_at<=$6::timestamptz AND a.latest_message_at>=$5::timestamptz)) ORDER BY last_imported_at DESC LIMIT 51`,
      [
        userId,
        parsed.name,
        parsed.fileHash,
        parsed.textHash,
        span.firstMessageAt,
        span.latestMessageAt,
      ],
    )
  ).rows.map(archiveOf);
  const known = (
    await client.query<{ archive_id: string }>(
      'SELECT archive_id FROM chat_archive_imports WHERE user_id=$1 AND (file_hash=$2 OR text_hash=$3)',
      [userId, parsed.fileHash, parsed.textHash],
    )
  ).rows;
  const exact = new Set(known.map((k) => k.archive_id));
  const candidates: Preview['candidates'] = [];
  let loaded = 0,
    incomplete = archives.length > 50;
  for (const archive of archives.slice(0, 50)) {
    if (exact.has(archive.id)) {
      candidates.push({
        archive,
        duplicateCount: parsed.messages.length,
        newCount: 0,
        confidence: 1,
      });
      continue;
    }
    // Restrict overlap analysis to the imported time range and a bounded global comparison budget.
    const overlapping =
      archive.firstMessageAt &&
      archive.latestMessageAt &&
      span.firstMessageAt &&
      span.latestMessageAt &&
      archive.firstMessageAt <= span.latestMessageAt &&
      archive.latestMessageAt >= span.firstMessageAt;
    if (!overlapping || loaded >= 300_000) {
      if (overlapping) incomplete = true;
      candidates.push({
        archive,
        duplicateCount: 0,
        newCount: parsed.messages.length,
        confidence: 0,
      });
      continue;
    }
    const old = (
      await client.query<{ id: string; fingerprint: string }>(
        'SELECT id,fingerprint FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2 AND at>=$3 AND at<=$4 ORDER BY at,position LIMIT $5',
        [userId, archive.id, span.firstMessageAt, span.latestMessageAt, 300_001 - loaded],
      )
    ).rows;
    loaded += old.length;
    if (loaded > 300_000) incomplete = true;
    const duplicates = reconcileMessages(old, parsed.messages).filter(Boolean).length;
    const confidence =
      archive.timeZone === parsed.timeZone ? overlapConfidence(old, parsed.messages) : 0;
    candidates.push({
      archive,
      duplicateCount: duplicates,
      newCount: parsed.messages.length - duplicates,
      confidence,
    });
  }
  if (incomplete)
    parsed.warnings.push(
      'Molte conversazioni sovrapposte: scegli manualmente la destinazione per evitare accorpamenti incerti.',
    );
  candidates.sort((a, b) => b.confidence - a.confidence || b.duplicateCount - a.duplicateCount);
  const strong = candidates.filter((c) => c.confidence >= 0.95);
  return {
    name: parsed.name,
    kind: parsed.kind,
    parsedCount: parsed.messages.length,
    warningCount: parsed.warnings.length,
    warnings: parsed.warnings,
    unparsedCount: parsed.unparsedLines.length,
    ...bounds(parsed),
    participants: parsed.participants,
    candidates: candidates.slice(0, 10),
    suggestedArchiveId: !incomplete && strong.length === 1 ? (strong[0]?.archive.id ?? null) : null,
  };
}
function whereMessages(userId: string, id: string, options: MessageQuery) {
  const params: unknown[] = [userId, id];
  const where = ['user_id=$1', 'archive_id=$2'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (options.query?.trim())
    add("search @@ websearch_to_tsquery('simple', ?)", options.query.slice(0, 500));
  if (options.senderId) add('sender_id=?::uuid', options.senderId);
  if (options.from) add('at>=?::timestamptz', options.from);
  if (options.to) add('at<?::timestamptz', options.to);
  return { where: where.join(' AND '), params };
}

export function createChatArchiveRepository(pool: Pool): ChatArchiveRepository {
  return {
    async preview(userId, input) {
      const parsed = parseArchiveFile(input);
      return withUser(pool, userId, (c) => previewParsed(c, userId, parsed));
    },
    async import(userId, input) {
      const parsed = parseArchiveFile(input);
      if (input.archiveId && input.createNew)
        return error(400, 'invalid_destination', 'Scegli una chat esistente oppure una nuova.');
      return withUser(pool, userId, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `chat-archive:${userId}`,
        ]);
        // An explicit destination needs no cross-archive scan; routing remains conservative otherwise.
        const preview =
          !input.archiveId && !input.createNew ? await previewParsed(c, userId, parsed) : null;
        let id = input.archiveId ?? preview?.suggestedArchiveId;
        if (!id && !input.createNew && preview?.candidates.length)
          return error(
            409,
            'archive_choice_required',
            'Scegli la conversazione da aggiornare oppure crea una nuova chat.',
          );
        let archive: Archive | null;
        if (id) {
          archive = await getArchive(c, userId, id, true);
          if (!archive) return error(404, 'not_found', 'Conversazione non trovata.');
        } else {
          id = randomUUID();
          const name = (input.name ?? parsed.name).trim().slice(0, 160);
          if (!name) return error(400, 'invalid_name', 'Scegli un nome per la chat.');
          const result = await c.query(
            'INSERT INTO chat_archives (id,user_id,name,kind,time_zone) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [id, userId, name, input.kind ?? parsed.kind, parsed.timeZone],
          );
          archive = archiveOf(result.rows[0]);
        }
        if (archive.timeZone !== parsed.timeZone)
          return error(
            409,
            'timezone_mismatch',
            `Questa chat usa il fuso ${archive.timeZone}. Usa lo stesso fuso per aggiornare l’archivio.`,
          );
        const existingImport = (
          await c.query(
            'SELECT * FROM chat_archive_imports WHERE user_id=$1 AND archive_id=$2 AND (file_hash=$3 OR text_hash=$4) LIMIT 1',
            [userId, id, parsed.fileHash, parsed.textHash],
          )
        ).rows[0];
        if (existingImport) {
          const updated = await c.query(
            'UPDATE chat_archives SET last_imported_at=now() WHERE user_id=$1 AND id=$2 RETURNING *',
            [userId, id],
          );
          return {
            archive: archiveOf(updated.rows[0]),
            parsedCount: parsed.messages.length,
            insertedCount: 0,
            duplicateCount: parsed.messages.length,
            warningCount: parsed.warnings.length,
            warnings: parsed.warnings,
            unparsedCount: parsed.unparsedLines.length,
          };
        }
        const old = await fingerprints(c, userId, id, parsed),
          matches = reconcileMessages(old, parsed.messages);
        const insertedCount = matches.filter((m) => m === null).length;
        const duplicateCount = parsed.messages.length - insertedCount;
        const warnings = [...parsed.warnings];
        if (new Set(parsed.messages.map((m) => m.fingerprint)).size < parsed.messages.length)
          warnings.push(
            'Sono presenti messaggi identici ripetuti: conservate le occorrenze distinte, con corrispondenza ordinata.',
          );
        const imported = randomUUID();
        await c.query(
          'INSERT INTO chat_archive_imports (id,user_id,archive_id,filename,file_hash,text_hash,raw_text,time_zone,parsed_count,inserted_count,duplicate_count,warnings,unparsed_lines) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)',
          [
            imported,
            userId,
            id,
            parsed.filename,
            parsed.fileHash,
            parsed.textHash,
            parsed.rawText,
            parsed.timeZone,
            parsed.messages.length,
            insertedCount,
            duplicateCount,
            JSON.stringify(warnings),
            JSON.stringify(parsed.unparsedLines),
          ],
        );
        const senders = new Map<string, string>();
        const senderRows = [
          ...new Map(
            parsed.messages.flatMap((m) =>
              m.senderKey && m.sender
                ? [[m.senderKey, { key: m.senderKey, name: m.sender, at: m.at }] as const]
                : [],
            ),
          ).values(),
        ];
        for (let i = 0; i < senderRows.length; i += 1000) {
          const result = await c.query(
            `INSERT INTO chat_archive_participants (user_id,archive_id,sender_key,name,first_message_at,last_message_at) SELECT $1,$2,x.key,x.name,x.at::timestamptz,x.at::timestamptz FROM jsonb_to_recordset($3::jsonb) x(key text,name text,at text) ON CONFLICT (user_id,archive_id,sender_key) DO UPDATE SET name=EXCLUDED.name RETURNING id,sender_key`,
            [userId, id, JSON.stringify(senderRows.slice(i, i + 1000))],
          );
          for (const r of result.rows) senders.set(String(r.sender_key), String(r.id));
        }
        const max = (
          await c.query(
            'SELECT COALESCE(max(position),-1) AS last FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2',
            [userId, id],
          )
        ).rows[0];
        let position = Number(max?.last ?? -1) + 1;
        const newRows: Array<Record<string, unknown>> = [],
          occurrences: Array<Record<string, unknown>> = [];
        for (let i = 0; i < parsed.messages.length; i++) {
          const m = parsed.messages[i];
          if (!m) continue;
          const messageId = matches[i] ?? randomUUID();
          if (!matches[i])
            newRows.push({
              id: messageId,
              senderId: m.senderKey ? (senders.get(m.senderKey) ?? null) : null,
              sender: m.sender,
              at: m.at,
              localTimestamp: m.localTimestamp,
              rawText: m.rawText,
              text: m.text,
              type: m.type,
              fingerprint: m.fingerprint,
              position: position++,
            });
          occurrences.push({ messageId, position: i, start: m.rawLineStart, end: m.rawLineEnd });
        }
        for (let i = 0; i < newRows.length; i += 1000)
          await c.query(
            `INSERT INTO chat_archive_messages (id,user_id,archive_id,sender_id,sender,at,local_timestamp,raw_text,body,message_type,fingerprint,position) SELECT x.id::uuid,$1,$2,x."senderId"::uuid,x.sender,x.at::timestamptz,x."localTimestamp",x."rawText",x.text,x.type,x.fingerprint,x.position FROM jsonb_to_recordset($3::jsonb) x(id text,"senderId" text,sender text,at text,"localTimestamp" text,"rawText" text,text text,type text,fingerprint text,position integer)`,
            [userId, id, JSON.stringify(newRows.slice(i, i + 1000))],
          );
        for (let i = 0; i < occurrences.length; i += 1000)
          await c.query(
            `INSERT INTO chat_archive_occurrences (user_id,archive_id,import_id,message_id,position,raw_line_start,raw_line_end) SELECT $1,$2,$3,x."messageId"::uuid,x.position,x.start,x."end" FROM jsonb_to_recordset($4::jsonb) x("messageId" text,position integer,start integer,"end" integer)`,
            [userId, id, imported, JSON.stringify(occurrences.slice(i, i + 1000))],
          );
        await c.query(
          'UPDATE chat_archive_participants p SET message_count=s.n,first_message_at=s.first,last_message_at=s.last FROM (SELECT sender_id,count(*)::integer n,min(at) first,max(at) last FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2 AND sender_id IS NOT NULL GROUP BY sender_id) s WHERE p.user_id=$1 AND p.archive_id=$2 AND p.id=s.sender_id',
          [userId, id],
        );
        const updated = await c.query(
          `UPDATE chat_archives a SET message_count=s.n,first_message_at=s.first,latest_message_at=s.last,participant_count=(SELECT count(*) FROM chat_archive_participants WHERE user_id=$1 AND archive_id=$2),last_imported_at=now(),revision=revision+$3,indexed_revision=revision+$3,indexed_at=CASE WHEN $3>0 THEN now() ELSE indexed_at END FROM (SELECT count(*)::integer n,min(at) first,max(at) last FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2) s WHERE a.user_id=$1 AND a.id=$2 RETURNING a.*`,
          [userId, id, insertedCount ? 1 : 0],
        );
        return {
          archive: archiveOf(updated.rows[0]),
          parsedCount: parsed.messages.length,
          insertedCount,
          duplicateCount,
          warningCount: warnings.length,
          warnings,
          unparsedCount: parsed.unparsedLines.length,
        };
      });
    },
    async list(userId, options = {}) {
      return withUser(pool, userId, async (c) => {
        const query = options.query?.trim().slice(0, 160) ?? '';
        const params = [userId, query];
        const where =
          "user_id=$1 AND ($2='' OR name ILIKE '%'||$2||'%' OR summary ILIKE '%'||$2||'%' OR category ILIKE '%'||$2||'%' OR array_to_string(tags,' ') ILIKE '%'||$2||'%')";
        const total = Number(
          (await c.query(`SELECT count(*) FROM chat_archives WHERE ${where}`, params)).rows[0]
            ?.count ?? 0,
        );
        const rows = (
          await c.query(
            `SELECT * FROM chat_archives WHERE ${where} ORDER BY last_imported_at DESC,id LIMIT $3 OFFSET $4`,
            [...params, clamp(options.limit, 1, 100, 30), clamp(options.offset, 0, 100_000, 0)],
          )
        ).rows;
        return { archives: rows.map(archiveOf), total };
      });
    },
    async get(userId, id) {
      return withUser(pool, userId, async (c) => {
        const archive = await getArchive(c, userId, id);
        if (!archive) return null;
        const participants = (
          await c.query(
            'SELECT * FROM chat_archive_participants WHERE user_id=$1 AND archive_id=$2 ORDER BY name,id',
            [userId, id],
          )
        ).rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          messageCount: Number(r.message_count),
          firstMessageAt: iso(r.first_message_at),
          lastMessageAt: iso(r.last_message_at),
        }));
        return { archive, participants };
      });
    },
    async messages(userId, id, options = {}) {
      return withUser(pool, userId, async (c) => {
        if (!(await getArchive(c, userId, id))) return { messages: [], total: 0 };
        if (options.aroundId) {
          const rows = await c.query(
            `WITH ranked AS (SELECT *,row_number() OVER (ORDER BY at,position) n FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2), anchor AS (SELECT n FROM ranked WHERE id=$3) SELECT ranked.* FROM ranked,anchor WHERE ranked.n BETWEEN anchor.n-10 AND anchor.n+10 ORDER BY ranked.n`,
            [userId, id, options.aroundId],
          );
          return { messages: rows.rows.map(messageOf), total: rows.rowCount ?? 0 };
        }
        const scope = whereMessages(userId, id, options),
          total = Number(
            (
              await c.query(
                `SELECT count(*) FROM chat_archive_messages WHERE ${scope.where}`,
                scope.params,
              )
            ).rows[0]?.count ?? 0,
          );
        const rows = await c.query(
          `SELECT * FROM chat_archive_messages WHERE ${scope.where} ORDER BY at,position LIMIT $${scope.params.length + 1} OFFSET $${scope.params.length + 2}`,
          [...scope.params, clamp(options.limit, 1, 200, 50), clamp(options.offset, 0, 100_000, 0)],
        );
        return { messages: rows.rows.map(messageOf), total };
      });
    },
    async update(userId, id, patch: ArchivePatch) {
      const sets: string[] = [],
        values: unknown[] = [userId, id];
      const set = (key: string, value: unknown) => {
        values.push(value);
        sets.push(`${key}=$${values.length}`);
      };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name || name.length > 160) return error(400, 'invalid_name', 'Nome non valido.');
        set('name', name);
      }
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.category !== undefined)
        set('category', patch.category?.trim().slice(0, 80) || null);
      if (patch.summary !== undefined) set('summary', patch.summary?.trim().slice(0, 600) || null);
      if (patch.tags !== undefined)
        set('tags', [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 10));
      if (patch.whatsappPhone !== undefined)
        set('whatsapp_phone', normalizeWhatsAppPhone(patch.whatsappPhone));
      if (patch.whatsappUrl !== undefined)
        set('whatsapp_url', normalizeWhatsAppUrl(patch.whatsappUrl));
      return withUser(pool, userId, async (c) => {
        if (!sets.length) return getArchive(c, userId, id);
        const rows = await c.query(
          `UPDATE chat_archives SET ${sets.join(',')} WHERE user_id=$1 AND id=$2 RETURNING *`,
          values,
        );
        return rows.rows[0] ? archiveOf(rows.rows[0]) : null;
      });
    },
    async remove(userId, id) {
      return withUser(
        pool,
        userId,
        async (c) =>
          (await c.query('DELETE FROM chat_archives WHERE user_id=$1 AND id=$2', [userId, id]))
            .rowCount === 1,
      );
    },
    async retrieve(userId, id, options = {}) {
      return withUser(pool, userId, async (c) => {
        // Imports acquire FOR UPDATE first; this shared archive lock keeps content and revision coherent.
        const archive = await getArchive(c, userId, id, 'share');
        if (!archive) return null;
        const scope = whereMessages(userId, id, options),
          limit = clamp(options.limit, 1, 400, 120);
        const matchedCount = Number(
          (
            await c.query(
              `SELECT count(*) FROM chat_archive_messages WHERE ${scope.where}`,
              scope.params,
            )
          ).rows[0]?.count ?? 0,
        );
        const hits = (
          await c.query(
            `SELECT * FROM chat_archive_messages WHERE ${scope.where} ORDER BY at DESC,position DESC LIMIT $${scope.params.length + 1}`,
            [...scope.params, limit],
          )
        ).rows;
        let rows = hits;
        if (options.query?.trim() && hits.length) {
          // Context stays strictly inside this archive; chronological neighbors cover replies without keywords.
          const ids = hits.slice(0, Math.min(50, limit)).map((r) => String(r.id));
          rows = (
            await c.query(
              `WITH ranked AS (SELECT *,row_number() OVER (ORDER BY at,position) n FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2), anchors AS (SELECT n FROM ranked WHERE id=ANY($3::uuid[])) SELECT DISTINCT ranked.* FROM ranked JOIN anchors ON ranked.n BETWEEN anchors.n-2 AND anchors.n+2 ORDER BY at,position LIMIT $4`,
              [userId, id, ids, Math.min(500, limit * 3)],
            )
          ).rows;
        }
        const merged = new Map<string, Record<string, unknown>>(hits.map((r) => [String(r.id), r]));
        for (const r of rows) merged.set(String(r.id), r);
        const messages = [...merged.values()]
          .map(messageOf)
          .sort((a, b) => a.at.localeCompare(b.at) || a.position - b.position);
        return { archive, messages, matchedCount, partial: matchedCount > hits.length };
      });
    },
  };
}
