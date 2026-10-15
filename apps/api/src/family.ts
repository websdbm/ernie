import { randomInt } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';

/**
 * Famiglia: collegamenti fra installazioni dello stesso server (utenti distinti) con etichetta e parentela.
 * Il collegamento nasce da un codice d'invito: chi invita sceglie come chiamerà l'altro e cosa è per lui,
 * l'altro lo accetta dal proprio telefono (consenso esplicito) e sceglie come chiamare chi lo ha invitato.
 * Ogni lato vede solo la propria riga; i promemoria «a Giorgio» passano da qui.
 */
export const RELATIONS = [
  'figlio',
  'genitore',
  'nonno',
  'nonna',
  'nipote',
  'partner',
  'altro',
] as const;
export type Relation = (typeof RELATIONS)[number];

/** Parentele che si possono seguire con l'invito apposito (0030, nonni dalla 0032). */
export const SUPERVISABLE = ['figlio', 'nonno', 'nonna'] as const;
export type Supervisable = (typeof SUPERVISABLE)[number];
export const isSupervisable = (r: Relation): r is Supervisable =>
  (SUPERVISABLE as readonly string[]).includes(r);

export interface FamilyLink {
  readonly id: string;
  readonly otherUserId: string;
  /** Come chiamo l'altro («Giorgio», «papà»). */
  readonly label: string;
  /** Cosa è l'altro per me. */
  readonly relation: Relation;
  readonly createdAt: Date;
}

export interface FamilyInvite {
  readonly code: string;
  readonly label: string;
  readonly relation: Relation;
  /** Come chi invita propone di farsi chiamare. */
  readonly myLabel: string;
  readonly expiresAt: Date;
  /** Account seguito (0030): accettando, il figlio (o il nonno) è seguito da chi invita. */
  readonly supervised: boolean;
  /** Skill che potrà usare se seguito (0032); null = predefinite. */
  readonly allowedSkills: string[] | null;
}

export class SupervisedUnlinkError extends Error {
  constructor() {
    super('l’account è seguito: può scollegarlo solo chi lo segue');
    this.name = 'SupervisedUnlinkError';
  }
}

export class OwnInviteError extends Error {
  constructor() {
    super('non puoi accettare un invito che hai creato tu');
    this.name = 'OwnInviteError';
  }
}

export interface FamilyRepository {
  list(userId: string): Promise<FamilyLink[]>;
  /** Collegamento per etichetta, senza distinguere maiuscole e accenti («giorgio» = «Giorgio»). */
  find(userId: string, label: string): Promise<FamilyLink | null>;
  /** Come `userId` chiama `otherUserId`; null se non sono collegati. */
  labelFor(userId: string, otherUserId: string): Promise<string | null>;
  /** `allowedSkills` vale solo per un invito con account seguito (già ripulito da chi chiama). */
  createInvite(
    userId: string,
    input: {
      label: string;
      relation: Relation;
      myLabel: string;
      supervised?: boolean | undefined;
      allowedSkills?: readonly string[] | undefined;
    },
  ): Promise<FamilyInvite>;
  /** Cosa propone un codice (per chi lo riceve, prima di accettare); null se non valido. */
  preview(
    userId: string,
    code: string,
  ): Promise<{
    label: string;
    myLabel: string;
    relation: Relation;
    supervised: boolean;
    allowedSkills: string[] | null;
  } | null>;
  listInvites(userId: string): Promise<FamilyInvite[]>;
  removeInvite(userId: string, code: string): Promise<boolean>;
  /**
   * Accetta un codice: crea le due righe; null se il codice non è valido, usato o scaduto. `relation` è cosa è
   * per me chi invita (senza: l'inversa di quella dell'invito).
   */
  accept(
    userId: string,
    code: string,
    label?: string,
    relation?: Relation,
  ): Promise<FamilyLink | null>;
  unlink(userId: string, otherUserId: string): Promise<boolean>;
}

export const normalizeLabel = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Senza 0/O e 1/I: il codice si detta a voce o si copia da un messaggio.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 48 * 3_600_000;

export function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

interface LRow {
  id: string;
  other_user_id: string;
  label: string;
  relation: Relation;
  created_at: Date;
}
interface IRow {
  code: string;
  label: string;
  relation: Relation;
  my_label: string;
  expires_at: Date;
  supervised: boolean;
  allowed_skills: string[] | null;
}

const toLink = (r: LRow): FamilyLink => ({
  id: r.id,
  otherUserId: r.other_user_id,
  label: r.label,
  relation: r.relation,
  createdAt: r.created_at,
});
const toInvite = (r: IRow): FamilyInvite => ({
  code: r.code,
  label: r.label,
  relation: r.relation,
  myLabel: r.my_label,
  expiresAt: r.expires_at,
  supervised: r.supervised,
  allowedSkills: r.allowed_skills,
});

export function createFamilyRepository(pool: Pool): FamilyRepository {
  const list = async (userId: string): Promise<FamilyLink[]> =>
    withUser(pool, userId, async (c) =>
      (
        await c.query<LRow>(
          `SELECT id, other_user_id, label, relation, created_at FROM family_links WHERE user_id = $1 ORDER BY created_at`,
          [userId],
        )
      ).rows.map(toLink),
    );
  return {
    list,
    async find(userId, label) {
      const wanted = normalizeLabel(label);
      if (!wanted) return null;
      return (await list(userId)).find((l) => normalizeLabel(l.label) === wanted) ?? null;
    },
    async labelFor(userId, otherUserId) {
      return withUser(
        pool,
        userId,
        async (c) =>
          (
            await c.query<{ label: string }>(
              `SELECT label FROM family_links WHERE user_id = $1 AND other_user_id = $2`,
              [userId, otherUserId],
            )
          ).rows[0]?.label ?? null,
      );
    },
    async createInvite(userId, input) {
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      // L'account seguito ha senso solo per figlio, nonno e nonna; le skill solo se è seguito.
      const supervised = input.supervised === true && isSupervisable(input.relation);
      const allowed = supervised && input.allowedSkills ? [...input.allowedSkills] : null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newInviteCode();
        try {
          return await withUser(pool, userId, async (c) => {
            const res = await c.query<IRow>(
              `INSERT INTO family_invites (code, user_id, relation, label, my_label, expires_at, supervised, allowed_skills)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING code, label, relation, my_label, expires_at, supervised, allowed_skills`,
              [
                code,
                userId,
                input.relation,
                input.label.trim(),
                input.myLabel.trim(),
                expiresAt,
                supervised,
                allowed,
              ],
            );
            const row = res.rows[0];
            if (!row) throw new Error('invito non creato');
            return toInvite(row);
          });
        } catch (err) {
          if ((err as { code?: string }).code !== '23505') throw err; // codice già usato: ritenta
        }
      }
      throw new Error('impossibile generare un codice d’invito');
    },
    async listInvites(userId) {
      return withUser(pool, userId, async (c) =>
        (
          await c.query<IRow>(
            `SELECT code, label, relation, my_label, expires_at, supervised, allowed_skills FROM family_invites
              WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at`,
            [userId],
          )
        ).rows.map(toInvite),
      );
    },
    async preview(userId, code) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{
          o_label: string;
          o_my_label: string;
          o_relation: Relation;
          o_supervised: boolean;
          o_allowed: string[] | null;
        }>(
          `SELECT o_label, o_my_label, o_relation, o_supervised, o_allowed FROM family_invite_preview($1)`,
          [code],
        );
        const row = r.rows[0];
        return row
          ? {
              label: row.o_label,
              myLabel: row.o_my_label,
              relation: row.o_relation,
              supervised: row.o_supervised,
              allowedSkills: row.o_allowed,
            }
          : null;
      });
    },
    async removeInvite(userId, code) {
      return withUser(
        pool,
        userId,
        async (c) =>
          (
            await c.query(`DELETE FROM family_invites WHERE user_id = $1 AND code = $2`, [
              userId,
              code.trim().toUpperCase(),
            ])
          ).rowCount === 1,
      );
    },
    async accept(userId, code, label, relation) {
      try {
        return await withUser(pool, userId, async (c) => {
          const res = await c.query<{
            o_id: string;
            o_other: string;
            o_label: string;
            o_relation: Relation;
          }>(`SELECT o_id, o_other, o_label, o_relation FROM family_accept_invite($1, $2, $3)`, [
            code,
            label ?? null,
            relation ?? null,
          ]);
          const row = res.rows[0];
          return row
            ? {
                id: row.o_id,
                otherUserId: row.o_other,
                label: row.o_label,
                relation: row.o_relation,
                createdAt: new Date(),
              }
            : null;
        });
      } catch (err) {
        if ((err as { message?: string }).message?.includes('invito_proprio'))
          throw new OwnInviteError();
        throw err;
      }
    },
    async unlink(userId, otherUserId) {
      try {
        return await withUser(
          pool,
          userId,
          async (c) =>
            (await c.query<{ n: number }>(`SELECT family_unlink($1) AS n`, [otherUserId])).rows[0]
              ?.n === 2,
        );
      } catch (err) {
        if ((err as { message?: string }).message?.includes('supervisione_attiva'))
          throw new SupervisedUnlinkError();
        throw err;
      }
    },
  };
}
