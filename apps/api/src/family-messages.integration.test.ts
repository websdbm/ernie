import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFamilyRepository } from './family.js';
import { createFamilyMessageStore, NotLinkedError } from './family-messages.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe.skipIf(!ready)('messaggi in famiglia (Postgres, RLS, 0033)', () => {
  let owner: Pool;
  let app: Pool;
  const papa = randomUUID();
  const giorgio = randomUUID();
  const estraneo = randomUUID();
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 4 });
    await owner.query(
      `INSERT INTO users (id, display_name) VALUES ($1, 'Papà'), ($2, 'Giorgio'), ($3, 'Estraneo')`,
      [papa, giorgio, estraneo],
    );
    const family = createFamilyRepository(app);
    const inv = await family.createInvite(papa, {
      label: 'Giorgio',
      relation: 'figlio',
      myLabel: 'papo',
    });
    await family.accept(giorgio, inv.code);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[papa, giorgio, estraneo]]);
    await owner.end();
    await app.end();
  });

  it('ognuno vede il messaggio con il nome che dà all’altro; foto; lettura; estranei esclusi', async () => {
    const store = createFamilyMessageStore(app);
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const sent = await store.send(papa, {
      to: giorgio,
      text: 'Vieni a cena!',
      image: { mime: 'image/jpeg', bytes: photo, width: 800, height: 600 },
    });
    expect(sent).toMatchObject({ direction: 'out', label: 'Giorgio', text: 'Vieni a cena!' });
    const seen = await store.get(giorgio, sent.id);
    expect(seen).toMatchObject({
      direction: 'in',
      label: 'papo',
      otherUserId: papa,
      image: { width: 800 },
    });
    expect((await store.image(giorgio, sent.id))?.bytes.equals(photo)).toBe(true);
    expect(await store.get(estraneo, sent.id)).toBeNull();
    expect(await store.image(estraneo, sent.id)).toBeNull();

    const reply = await store.send(giorgio, { to: papa, text: 'Arrivo', replyTo: sent.id });
    expect(reply).toMatchObject({ direction: 'out', label: 'papo', replyTo: sent.id });
    const list = await store.list(papa);
    expect(list.map((m) => [m.direction, m.text])).toEqual([
      ['out', 'Vieni a cena!'],
      ['in', 'Arrivo'],
    ]);
    expect(await store.list(papa, { since: sent.at })).toHaveLength(1);

    // Solo il destinatario segna la lettura.
    expect(await store.markRead(papa, [sent.id])).toBe(0);
    expect(await store.markRead(giorgio, [sent.id])).toBe(1);
    expect((await store.get(papa, sent.id))?.readAt).toBeInstanceOf(Date);

    // A una persona non collegata non si scrive.
    await expect(store.send(estraneo, { to: papa, text: 'ciao' })).rejects.toBeInstanceOf(
      NotLinkedError,
    );
  });
});
