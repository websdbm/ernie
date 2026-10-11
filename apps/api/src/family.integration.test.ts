import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFamilyRepository, normalizeLabel, OwnInviteError } from './family.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe('normalizeLabel', () => {
  it('ignora maiuscole, accenti e spazi doppi', () => {
    expect(normalizeLabel('  Papà ')).toBe('papa');
    expect(normalizeLabel('ZIO  Mario')).toBe('zio mario');
  });
});

describe.skipIf(!ready)('Famiglia (Postgres, ruolo applicativo + RLS)', () => {
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
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[papa, giorgio, estraneo]]);
    await owner.end();
    await app.end();
  });

  it('invito → accettazione → due righe con etichette e parentela speculari → scollegamento', async () => {
    const family = createFamilyRepository(app);
    const invite = await family.createInvite(papa, {
      label: 'Giorgio',
      relation: 'figlio',
      myLabel: 'papà',
    });
    expect(invite.code).toMatch(/^[A-Z2-9]{6}$/);
    expect((await family.listInvites(papa)).map((i) => i.code)).toEqual([invite.code]);
    expect(await family.listInvites(giorgio)).toEqual([]); // RLS: l'invito è di papà
    await expect(family.accept(papa, invite.code)).rejects.toBeInstanceOf(OwnInviteError);
    expect(await family.accept(estraneo, 'ZZZZZZ')).toBeNull();

    const link = await family.accept(giorgio, invite.code.toLowerCase(), '  Papà ');
    expect(link).toMatchObject({ otherUserId: papa, label: 'Papà', relation: 'genitore' });
    expect(await family.accept(estraneo, invite.code)).toBeNull(); // usato
    expect(await family.listInvites(papa)).toEqual([]);

    expect((await family.list(papa)).map((l) => [l.otherUserId, l.label, l.relation])).toEqual([
      [giorgio, 'Giorgio', 'figlio'],
    ]);
    expect((await family.list(giorgio)).map((l) => [l.otherUserId, l.label, l.relation])).toEqual([
      [papa, 'Papà', 'genitore'],
    ]);
    expect(await family.list(estraneo)).toEqual([]);
    expect((await family.find(papa, 'giorgio'))?.otherUserId).toBe(giorgio);
    expect((await family.find(giorgio, 'papa'))?.otherUserId).toBe(papa);
    expect(await family.find(estraneo, 'Giorgio')).toBeNull();
    expect(await family.labelFor(giorgio, papa)).toBe('Papà');
    expect(await family.labelFor(estraneo, papa)).toBeNull();

    expect(await family.unlink(estraneo, giorgio)).toBe(false);
    expect(await family.unlink(giorgio, papa)).toBe(true);
    expect(await family.list(papa)).toEqual([]);
    expect(await family.list(giorgio)).toEqual([]);
  });
});
