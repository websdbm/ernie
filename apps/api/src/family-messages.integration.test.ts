import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFamilyRepository } from './family.js';
import {
  createFamilyMessageStore,
  NotLinkedError,
  UrgentNotAllowedError,
} from './family-messages.js';

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

  it('urgenti (0034): solo ai figli, ripetizioni dovute, conferma del destinatario, scadenza', async () => {
    const store = createFamilyMessageStore(app);
    const urgent = await store.send(papa, { to: giorgio, text: 'Torna a casa', urgent: true });
    expect(urgent).toMatchObject({ urgent: true, acknowledgedAt: null });
    // Giorgio non può mandarne a papà (per lui è «genitore»).
    await expect(
      store.send(giorgio, { to: papa, text: 'Vieni', urgent: true }),
    ).rejects.toBeInstanceOf(UrgentNotAllowedError);

    // Appena mandato non è ancora dovuto; dopo un minuto sì, una volta sola per giro.
    expect((await store.urgentDue()).filter((d) => d.id === urgent.id)).toEqual([]);
    await owner.query(
      `UPDATE family_messages SET created_at = now() - interval '1 minute' WHERE id = $1`,
      [urgent.id],
    );
    expect((await store.urgentDue()).filter((d) => d.id === urgent.id)).toEqual([
      { id: urgent.id, senderId: papa, recipientId: giorgio, count: 1 },
    ]);
    expect((await store.urgentDue()).filter((d) => d.id === urgent.id)).toEqual([]);

    // Il destinatario non cambia il testo, solo lettura e conferma.
    await expect(
      withUser(app, giorgio, (c) =>
        c.query(`UPDATE family_messages SET body = 'altro' WHERE id = $1`, [urgent.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await store.acknowledge(papa, urgent.id)).toBe(false);
    expect(await store.acknowledge(giorgio, urgent.id)).toBe(true);
    expect(await store.acknowledge(giorgio, urgent.id)).toBe(false);
    expect((await store.get(papa, urgent.id))?.acknowledgedAt).toBeInstanceOf(Date);
    await owner.query(
      `UPDATE family_messages SET last_nag_at = now() - interval '5 minutes' WHERE id = $1`,
      [urgent.id],
    );
    expect((await store.urgentDue()).filter((d) => d.id === urgent.id)).toEqual([]);

    // Un'ora senza conferma: smette, e lo segnala una volta sola.
    const old = await store.send(papa, { to: giorgio, text: 'Chiamami', urgent: true });
    await owner.query(
      `UPDATE family_messages SET created_at = now() - interval '61 minutes' WHERE id = $1`,
      [old.id],
    );
    expect((await store.urgentDue()).filter((d) => d.id === old.id)).toEqual([]);
    expect((await store.urgentExpired()).filter((d) => d.id === old.id)).toEqual([
      { id: old.id, senderId: papa, recipientId: giorgio },
    ]);
    expect((await store.urgentExpired()).filter((d) => d.id === old.id)).toEqual([]);
  });
});
