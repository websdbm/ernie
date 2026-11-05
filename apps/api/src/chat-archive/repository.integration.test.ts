import { randomUUID } from 'node:crypto';
import { createPool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatArchiveRepository } from './repository.js';
import type { IncomingImport } from './types.js';

// Explicit opt-in and isolated database URLs: never run simply because the developer has a production .env.
const enabled =
  process.env.RUN_CHAT_ARCHIVE_INTEGRATION === '1' &&
  process.env.DATABASE_URL &&
  process.env.MIGRATIONS_DATABASE_URL;
const run = enabled ? describe : describe.skip;
const exportText = (count: number, prefix = 'messaggio', day = 5) =>
  Array.from(
    { length: count },
    (_, i) =>
      `[${String(day).padStart(2, '0')}/11/2026, ${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00] ${i % 2 ? 'Marco' : 'Anna'}: ${prefix} ${i}`,
  ).join('\n');
const file = (text: string, extra: Partial<IncomingImport> = {}): IncomingImport => ({
  filename: 'WhatsApp Chat con Scuola.txt',
  dataBase64: Buffer.from(text).toString('base64'),
  timeZone: 'Europe/Rome',
  ...extra,
});

run('chat archives PostgreSQL isolation and incremental ingestion', async () => {
  const app = createPool({ connectionString: process.env.DATABASE_URL ?? '' });
  const owner = createPool({ connectionString: process.env.MIGRATIONS_DATABASE_URL ?? '' });
  const a = randomUUID(),
    b = randomUUID();
  const repo = createChatArchiveRepository(app);
  beforeAll(async () => {
    await owner.query(
      "INSERT INTO users (id,display_name) VALUES ($1,'Archive test A'),($2,'Archive test B')",
      [a, b],
    );
  });
  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[a, b]]);
    await app.end();
    await owner.end();
  });
  it('imports100, repeats0, adds15 and keeps coherent revisions/participants', async () => {
    const first = await repo.import(
      a,
      file(exportText(100), { createNew: true, name: 'Progressiva' }),
    );
    expect(first.insertedCount).toBe(100);
    expect(first.archive.messageCount).toBe(100);
    const again = await repo.import(a, file(exportText(100), { archiveId: first.archive.id }));
    expect(again.insertedCount).toBe(0);
    expect(again.duplicateCount).toBe(100);
    expect(again.archive.revision).toBe(first.archive.revision);
    const preview = await repo.preview(a, file(exportText(115)));
    expect(preview.suggestedArchiveId).toBe(first.archive.id);
    const update = await repo.import(a, file(exportText(115), { archiveId: first.archive.id }));
    expect(update.insertedCount).toBe(15);
    expect(update.duplicateCount).toBe(100);
    expect(update.archive.messageCount).toBe(115);
    expect(update.archive.indexedRevision).toBe(update.archive.revision);
    const read = await repo.get(a, first.archive.id);
    expect(read?.participants).toHaveLength(2);
    expect(read?.participants.reduce((n, p) => n + p.messageCount, 0)).toBe(115);
    await expect(
      repo.import(a, file(exportText(115), { archiveId: first.archive.id, timeZone: 'UTC' })),
    ).rejects.toMatchObject({ code: 'timezone_mismatch' });
  });
  it('updates searchable catalog metadata and clears its summary without altering source revisions', async () => {
    const saved = await repo.import(a, file(exportText(2, 'catalogo', 12), { createNew: true }));
    const updated = await repo.update(a, saved.archive.id, {
      name: 'Famiglia e attività',
      category: 'Personale',
      summary: 'Orari della ginnastica e accordi settimanali.',
      tags: ['famiglia', 'sport'],
    });
    expect(updated?.summary).toBe('Orari della ginnastica e accordi settimanali.');
    expect(updated?.revision).toBe(saved.archive.revision);
    for (const query of ['Famiglia e attività', 'Personale', 'ginnastica', 'sport'])
      expect((await repo.list(a, { query })).archives.map((x) => x.id)).toContain(saved.archive.id);
    expect((await repo.list(b, { query: 'ginnastica' })).total).toBe(0);
    expect((await repo.update(a, saved.archive.id, { summary: null }))?.summary).toBeNull();
    expect((await repo.get(a, saved.archive.id))?.archive.summary).toBeNull();
    expect((await repo.list(a, { query: 'ginnastica' })).total).toBe(0);
  });
  it('never merges two equal-name chats with no overlapping content and makes equal-content archives ambiguous', async () => {
    const left = await repo.import(
      a,
      file(exportText(5, 'sinistra', 6), { createNew: true, name: 'Omonimo' }),
    );
    const right = await repo.import(
      a,
      file(exportText(5, 'destra', 6), { createNew: true, name: 'Omonimo' }),
    );
    expect(left.archive.id).not.toBe(right.archive.id);
    const clone = await repo.import(
      a,
      file(exportText(5, 'sinistra', 6), { createNew: true, name: 'Copia scelta' }),
    );
    expect(clone.archive.id).not.toBe(left.archive.id);
    const preview = await repo.preview(a, file(exportText(5, 'sinistra', 6)));
    expect(preview.suggestedArchiveId).toBeNull();
    await expect(repo.import(a, file(exportText(5, 'sinistra', 6)))).rejects.toMatchObject({
      code: 'archive_choice_required',
    });
  });
  it('retains deliberate same-minute repeats and prepended historical content in chronological source order', async () => {
    const body =
      '[05/11/2026, 10:00] Anna: sì\n[05/11/2026, 10:00] Anna: sì\n[05/11/2026, 10:01] Marco: fine';
    const one = await repo.import(a, file(body, { createNew: true }));
    const prepended = `[04/11/2026, 09:00] Anna: ieri\n${body}\n[05/11/2026, 10:02] Marco: dopo`;
    const two = await repo.import(a, file(prepended, { archiveId: one.archive.id }));
    expect(two.insertedCount).toBe(2);
    expect(two.duplicateCount).toBe(3);
    expect(two.archive.messageCount).toBe(5);
    const messages = await repo.messages(a, one.archive.id);
    expect(messages.messages.map((m) => m.text)).toEqual(['ieri', 'sì', 'sì', 'fine', 'dopo']);
    const around = await repo.messages(a, one.archive.id, {
      aroundId: messages.messages[0]?.id ?? randomUUID(),
    });
    expect(around.messages.map((m) => m.id)).toEqual(messages.messages.map((m) => m.id));
  });
  it('filters retrieval by archive/sender/time, includes source neighbors, and reports capped coverage', async () => {
    const saved = await repo.import(a, file(exportText(12, 'gita', 7), { createNew: true }));
    const other = await repo.import(a, file(exportText(3, 'segreto', 8), { createNew: true }));
    const detail = await repo.get(a, saved.archive.id);
    const participant = detail?.participants.find((p) => p.name === 'Marco');
    const retrieval = await repo.retrieve(a, saved.archive.id, { query: 'gita', limit: 2 });
    expect(retrieval?.matchedCount).toBe(12);
    expect(retrieval?.partial).toBe(true);
    expect(retrieval?.messages.every((m) => m.text.includes('gita'))).toBe(true);
    const filtered = await repo.messages(a, saved.archive.id, {
      senderId: participant?.id ?? randomUUID(),
      from: '2026-11-07T09:03:00Z',
      to: '2026-11-07T09:08:00Z',
    });
    expect(filtered.messages.map((m) => m.text)).toEqual(['gita 3', 'gita 5', 'gita 7']);
    expect((await repo.retrieve(a, saved.archive.id, { query: 'segreto' }))?.messages).toEqual([]);
    const foreignSource = (await repo.messages(a, other.archive.id)).messages[0];
    expect(
      (await repo.messages(a, saved.archive.id, { aroundId: foreignSource?.id ?? randomUUID() }))
        .messages,
    ).toEqual([]);
  });
  it('enforces owner RLS and composite archive FKs, cascades deletion and blocks cross-user mutation', async () => {
    const saved = await repo.import(a, file(exportText(3, 'privato', 9), { createNew: true }));
    expect((await repo.list(b)).total).toBe(0);
    expect(await repo.get(b, saved.archive.id)).toBeNull();
    expect(await repo.retrieve(b, saved.archive.id)).toBeNull();
    expect(await repo.update(b, saved.archive.id, { name: 'rubato' })).toBeNull();
    expect(await repo.remove(b, saved.archive.id)).toBe(false);
    await expect(
      repo.import(b, file(exportText(3), { archiveId: saved.archive.id })),
    ).rejects.toMatchObject({ code: 'not_found' });
    const direct = await withUser(app, b, (c) =>
      c.query('SELECT id FROM chat_archive_messages WHERE archive_id=$1', [saved.archive.id]),
    );
    expect(direct.rows).toEqual([]);
    const elsewhere = await repo.import(a, file(exportText(2, 'altro', 10), { createNew: true }));
    const elsewherePerson = (await repo.get(a, elsewhere.archive.id))?.participants[0];
    await expect(
      withUser(app, a, (c) =>
        c.query(
          "INSERT INTO chat_archive_messages (user_id,archive_id,sender_id,at,local_timestamp,raw_text,body,message_type,fingerprint,position) VALUES ($1,$2,$3,now(),'x','x','x','text','x',999)",
          [a, saved.archive.id, elsewherePerson?.id],
        ),
      ),
    ).rejects.toThrow();
    expect(await repo.remove(a, saved.archive.id)).toBe(true);
    const counts = await owner.query(
      'SELECT (SELECT count(*) FROM chat_archive_messages WHERE archive_id=$1)+(SELECT count(*) FROM chat_archive_imports WHERE archive_id=$1)+(SELECT count(*) FROM chat_archive_participants WHERE archive_id=$1)+(SELECT count(*) FROM chat_archive_occurrences WHERE archive_id=$1) n',
      [saved.archive.id],
    );
    expect(Number(counts.rows[0].n)).toBe(0);
  });
  it('serializes concurrent reimports and holds archive snapshot stable with a share lock', async () => {
    const original = await repo.import(a, file(exportText(4, 'race', 11), { createNew: true }));
    const [left, right] = await Promise.all([
      repo.import(a, file(exportText(6, 'race', 11), { archiveId: original.archive.id })),
      repo.import(a, file(exportText(6, 'race', 11), { archiveId: original.archive.id })),
    ]);
    expect(left.insertedCount + right.insertedCount).toBe(2);
    expect((await repo.get(a, original.archive.id))?.archive.messageCount).toBe(6);
    const client = await app.connect();
    let update: Promise<unknown> | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id',$1,true)", [a]);
      await client.query('SELECT id FROM chat_archives WHERE user_id=$1 AND id=$2 FOR SHARE', [
        a,
        original.archive.id,
      ]);
      let finished = false;
      update = repo
        .import(a, file(exportText(7, 'race', 11), { archiveId: original.archive.id }))
        .then((x) => {
          finished = true;
          return x;
        });
      await new Promise((r) => setTimeout(r, 80));
      expect(finished).toBe(false);
      const count = await client.query(
        'SELECT count(*) FROM chat_archive_messages WHERE user_id=$1 AND archive_id=$2',
        [a, original.archive.id],
      );
      expect(Number(count.rows[0].count)).toBe(6);
      await client.query('COMMIT');
      await update;
      expect((await repo.get(a, original.archive.id))?.archive.messageCount).toBe(7);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await update;
    }
  });
});
