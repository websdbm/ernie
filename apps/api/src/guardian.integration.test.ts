import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import { disabledToolIds, enabledSkillIds } from '@ernie/skills';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFamilyRepository, SupervisedUnlinkError } from './family.js';
import { createGuardianStore, guardianSettings, toTranscriptMessage } from './guardian.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

describe('registro per il genitore: messaggi salvati → righe leggibili', () => {
  it('testo, voce, strumenti usati; il ragionamento resta fuori', () => {
    expect(
      toTranscriptMessage({
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: '[voce] che compiti ho?' }] },
        createdAt: new Date('2026-10-14T15:00:00Z'),
      }),
    ).toEqual({
      role: 'user',
      text: 'che compiti ho?',
      at: '2026-10-14T15:00:00.000Z',
      voice: true,
      tools: [],
    });
    expect(
      toTranscriptMessage({
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'reasoning', reasoning: 'penso…' },
            {
              type: 'tool-invocation',
              toolInvocation: { toolName: 'web_search', state: 'result' },
            },
            { type: 'text', text: 'Ecco cosa ho trovato.' },
          ],
        },
        createdAt: new Date('2026-10-14T15:00:05Z'),
      }),
    ).toMatchObject({ role: 'assistant', text: 'Ecco cosa ho trovato.', tools: ['web_search'] });
    expect(toTranscriptMessage({ role: 'system', content: 'x' })).toBeNull();
  });

  it('impostazioni effettive del figlio: solo le skill concesse, web spento se non concesso', () => {
    const s = guardianSettings({}, ['ricordami', 'documenti']);
    expect([...enabledSkillIds(s)].sort()).toEqual(['documenti', 'ricordami']);
    const off = disabledToolIds(s);
    expect(off.has('web_search')).toBe(true);
    expect(off.has('brain_write')).toBe(true);
    expect(disabledToolIds(guardianSettings({}, ['ricordami', 'web'])).has('web_search')).toBe(
      false,
    );
    expect(guardianSettings({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe.skipIf(!ready)('controllo genitori (Postgres, RLS, funzioni della 0030)', () => {
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

  it('invito con controllo → anteprima → accettazione; limiti, consultazioni visibili al figlio; solo il genitore lo toglie', async () => {
    const family = createFamilyRepository(app);
    const guardian = createGuardianStore(app);
    const invite = await family.createInvite(papa, {
      label: 'Giorgio',
      relation: 'figlio',
      myLabel: 'papà',
      supervised: true,
    });
    expect(invite.supervised).toBe(true);
    expect(await family.preview(giorgio, invite.code)).toEqual({
      label: 'Giorgio',
      myLabel: 'papà',
      relation: 'figlio',
      supervised: true,
    });
    expect(await family.preview(papa, invite.code)).toBeNull();
    expect(await guardian.limitsFor(giorgio)).toBeNull();

    await family.accept(giorgio, invite.code);
    expect(await guardian.children(papa)).toMatchObject([
      {
        childId: giorgio,
        label: 'Giorgio',
        allowed: ['ricordami', 'shopping_list', 'documenti'],
        lastReviewAt: null,
      },
    ]);
    expect(await guardian.limitsFor(giorgio)).toEqual(['ricordami', 'shopping_list', 'documenti']);
    expect(await guardian.isGuardian(papa, giorgio)).toBe(true);
    expect(await guardian.isGuardian(giorgio, papa)).toBe(false);
    expect(await guardian.isGuardian(estraneo, giorgio)).toBe(false);

    // Il figlio non può cambiare le proprie skill né togliere il controllo, nemmeno scollegandosi.
    const childUpdate = await withUser(app, giorgio, (c) =>
      c.query(`UPDATE guardianships SET allowed_skills = ARRAY['web'] WHERE child_id = $1`, [
        giorgio,
      ]),
    );
    expect(childUpdate.rowCount).toBe(0);
    await expect(family.unlink(giorgio, papa)).rejects.toBeInstanceOf(SupervisedUnlinkError);
    expect(await guardian.release(giorgio, giorgio)).toBe(false);

    // Il genitore sceglie le skill (id sconosciuti scartati) e consulta: il figlio lo vede.
    expect(await guardian.setAllowed(papa, giorgio, ['ricordami', 'web', 'inventata'])).toEqual([
      'ricordami',
      'web',
    ]);
    expect(await guardian.setAllowed(estraneo, giorgio, ['web'])).toBeNull();
    await guardian.recordReview(papa, giorgio, null);
    await expect(
      withUser(app, estraneo, (c) =>
        c.query(`INSERT INTO guardian_reviews (guardian_id, child_id) VALUES ($1, $2)`, [
          estraneo,
          giorgio,
        ]),
      ),
    ).rejects.toThrow();
    const seen = await guardian.supervision(giorgio);
    expect(seen?.guardians).toMatchObject([{ label: 'papà' }]);
    expect(seen?.guardians[0]?.lastReviewAt).toBeInstanceOf(Date);
    expect(seen?.allowed).toEqual(['ricordami', 'web']);
    expect(await guardian.supervision(estraneo)).toBeNull();

    // Scollegando il figlio, il genitore toglie anche il controllo.
    expect(await family.unlink(papa, giorgio)).toBe(true);
    expect(await guardian.limitsFor(giorgio)).toBeNull();
  });

  it('il controllo genitori vale solo invitando un figlio', async () => {
    const family = createFamilyRepository(app);
    const invite = await family.createInvite(papa, {
      label: 'Estraneo',
      relation: 'partner',
      myLabel: 'Ale',
      supervised: true,
    });
    expect(invite.supervised).toBe(false);
    await family.accept(estraneo, invite.code);
    expect(await createGuardianStore(app).limitsFor(estraneo)).toBeNull();
    await family.unlink(papa, estraneo);
  });
});
