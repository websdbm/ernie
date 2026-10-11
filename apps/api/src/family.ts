import { randomInt } from 'node:crypto';
import { type Pool, withUser } from '@ernie/db';

/**
 * Famiglia: collegamenti fra installazioni dello stesso server (utenti distinti) con etichetta e parentela.
 * Il collegamento nasce da un codice d'invito: chi invita sceglie come chiamerà l'altro e cosa è per lui,
 * l'altro lo accetta dal proprio telefono (consenso esplicito) e sceglie come chiamare chi lo ha invitato.
 * Ogni lato vede solo la propria riga; i promemoria «a Giorgio» passano da qui.
 */
export const RELATIONS = ['figlio', 'genitore', 'partner', 'altro'] as const;
export type Relation = (typeof RELATIONS)[number];

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
  createInvite(
    userId: string,
    input: { label: string; relation: Relation; myLabel: string },
  ): Promise<FamilyInvite>;
  listInvites(userId: string): Promise<FamilyInvite[]>;
  removeInvite(userId: string, code: string): Promise<boolean>;
  /** Accetta un codice: crea le due righe; null se il codice non è valido, usato o scaduto. */
  accept(userId: string, code: string, label?: string): Promise<FamilyLink | null>;
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
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newInviteCode();
        try {
          return await withUser(pool, userId, async (c) => {
            const res = await c.query<IRow>(
              `INSERT INTO family_invites (code, user_id, relation, label, my_label, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING code, label, relation, my_label, expires_at`,
              [code, userId, input.relation, input.label.trim(), input.myLabel.trim(), expiresAt],
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
            `SELECT code, label, relation, my_label, expires_at FROM family_invites
              WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at`,
            [userId],
          )
        ).rows.map(toInvite),
      );
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
    async accept(userId, code, label) {
      try {
        return await withUser(pool, userId, async (c) => {
          const res = await c.query<{
            o_id: string;
            o_other: string;
            o_label: string;
            o_relation: Relation;
          }>(`SELECT o_id, o_other, o_label, o_relation FROM family_accept_invite($1, $2)`, [
            code,
            label ?? null,
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
      return withUser(
        pool,
        userId,
        async (c) =>
          (await c.query<{ n: number }>(`SELECT family_unlink($1) AS n`, [otherUserId])).rows[0]
            ?.n === 2,
      );
    },
  };
}
