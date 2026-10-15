import { type Pool, withUser } from '@ernie/db';
import { defineTool, ToolError } from '@ernie/tools';
import { z } from 'zod';

/**
 * Messaggi in famiglia (migrazione 0033): testo breve e foto facoltativa fra persone collegate. Ogni lato vede il
 * messaggio con il nome che dà all'altro (family_links): chi riceve lo vede «da papà», chi scrive «a Giorgio».
 */
export interface FamilyMessage {
  readonly id: string;
  /** «in» ricevuto, «out» scritto da me. */
  readonly direction: 'in' | 'out';
  readonly otherUserId: string;
  /** Come chiamo l'altro (mittente o destinatario). */
  readonly label: string;
  readonly text: string;
  readonly image: { readonly width: number | null; readonly height: number | null } | null;
  readonly replyTo: string | null;
  readonly at: Date;
  readonly readAt: Date | null;
}

export interface FamilyMessageImage {
  readonly mime: string;
  readonly bytes: Buffer;
}

export interface NewFamilyMessage {
  readonly to: string;
  readonly text: string;
  readonly image?: { mime: string; bytes: Buffer; width?: number; height?: number };
  readonly replyTo?: string;
}

export class NotLinkedError extends Error {
  constructor() {
    super('la persona non è collegata in Famiglia');
    this.name = 'NotLinkedError';
  }
}

export interface FamilyMessageStore {
  send(senderId: string, input: NewFamilyMessage): Promise<FamilyMessage>;
  /** Visto da `userId`: lo stesso messaggio come «out» per chi l'ha scritto e «in» per chi lo riceve. */
  get(userId: string, id: string): Promise<FamilyMessage | null>;
  /** Messaggi miei (inviati e ricevuti), dal più vecchio; `since` esclusivo. */
  list(userId: string, opts?: { since?: Date; limit?: number }): Promise<FamilyMessage[]>;
  image(userId: string, id: string): Promise<FamilyMessageImage | null>;
  markRead(userId: string, ids: readonly string[]): Promise<number>;
}

interface Row {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  reply_to: string | null;
  has_image: boolean;
  image_w: number | null;
  image_h: number | null;
  created_at: Date;
  read_at: Date | null;
  label: string | null;
}

const COLS = `m.id, m.sender_id, m.recipient_id, m.body, m.reply_to, (m.image_mime IS NOT NULL) AS has_image,
  m.image_w, m.image_h, m.created_at, m.read_at, l.label`;
// Il nome dell'altro dal mio collegamento (RLS: vedo solo le mie righe di family_links).
const JOIN = `LEFT JOIN family_links l ON l.user_id = $1
  AND l.other_user_id = CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END`;

function toMessage(r: Row, viewer: string): FamilyMessage {
  const out = r.sender_id === viewer;
  return {
    id: r.id,
    direction: out ? 'out' : 'in',
    otherUserId: out ? r.recipient_id : r.sender_id,
    label: r.label ?? 'un familiare',
    text: r.body,
    image: r.has_image ? { width: r.image_w, height: r.image_h } : null,
    replyTo: r.reply_to,
    at: r.created_at,
    readAt: r.read_at,
  };
}

export function createFamilyMessageStore(pool: Pool): FamilyMessageStore {
  const get = (userId: string, id: string) =>
    withUser(pool, userId, async (c) => {
      const r = await c.query<Row>(
        `SELECT ${COLS} FROM family_messages m ${JOIN} WHERE m.id = $2`,
        [userId, id],
      );
      return r.rows[0] ? toMessage(r.rows[0], userId) : null;
    });
  return {
    get,
    async send(senderId, input) {
      const id = await withUser(pool, senderId, async (c) => {
        try {
          const r = await c.query<{ id: string }>(
            `INSERT INTO family_messages (sender_id, recipient_id, body, reply_to, image_mime, image_bytes, image_w, image_h)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              senderId,
              input.to,
              input.text.trim(),
              input.replyTo ?? null,
              input.image?.mime ?? null,
              input.image?.bytes ?? null,
              input.image?.width ?? null,
              input.image?.height ?? null,
            ],
          );
          return r.rows[0]?.id;
        } catch (err) {
          // 42501: la policy rifiuta l'inserimento (persona non collegata).
          if ((err as { code?: string }).code === '42501') throw new NotLinkedError();
          throw err;
        }
      });
      const msg = id ? await get(senderId, id) : null;
      if (!msg) throw new Error('messaggio non salvato');
      return msg;
    },
    async list(userId, opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      return withUser(pool, userId, async (c) => {
        const r = await c.query<Row>(
          `SELECT * FROM (
             SELECT ${COLS} FROM family_messages m ${JOIN}
              WHERE (m.sender_id = $1 OR m.recipient_id = $1) AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', m.created_at) > $2)
              ORDER BY m.created_at DESC LIMIT $3
           ) x ORDER BY created_at`,
          [userId, opts.since ?? null, limit],
        );
        return r.rows.map((row) => toMessage(row, userId));
      });
    },
    async image(userId, id) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query<{ image_mime: string | null; image_bytes: Buffer | null }>(
          `SELECT image_mime, image_bytes FROM family_messages WHERE id = $1`,
          [id],
        );
        const row = r.rows[0];
        return row?.image_mime && row.image_bytes
          ? { mime: row.image_mime, bytes: row.image_bytes }
          : null;
      });
    },
    async markRead(userId, ids) {
      if (!ids.length) return 0;
      return withUser(pool, userId, async (c) => {
        const r = await c.query(
          `UPDATE family_messages SET read_at = now() WHERE recipient_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
          [userId, ids],
        );
        return r.rowCount ?? 0;
      });
    },
  };
}

/** Blocco del protocollo (v1.16) per chi legge il messaggio. */
export function toFamilyMessageBlock(m: FamilyMessage) {
  return {
    kind: 'family_message' as const,
    id: m.id,
    direction: m.direction,
    otherUserId: m.otherUserId,
    label: m.label.slice(0, 60),
    text: m.text.slice(0, 2000),
    ...(m.image
      ? {
          image: {
            ...(m.image.width ? { width: m.image.width } : {}),
            ...(m.image.height ? { height: m.image.height } : {}),
          },
        }
      : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    at: m.at.toISOString(),
  };
}

export interface FamilyMessengerDeps {
  readonly store: FamilyMessageStore;
  /** Etichetta → collegamento (per i messaggi detti in chat: «scrivi a Giorgio»). */
  readonly findLink: (
    userId: string,
    label: string,
  ) => Promise<{ otherUserId: string; label: string } | null>;
  /** Scheda nella chat del destinatario, se è connesso. */
  readonly deliver: (
    userId: string,
    block: ReturnType<typeof toFamilyMessageBlock>,
  ) => Promise<void>;
  /** Notifica sul telefono del destinatario. */
  readonly push?: (
    userId: string,
    msg: { title: string; body: string; data: Record<string, unknown>; threadId: string },
  ) => Promise<unknown>;
  readonly logger?: { warn(obj: unknown, msg: string): void };
}

export interface FamilyMessenger {
  /** Salva, consegna (scheda e notifica) e restituisce il messaggio visto da chi scrive. */
  send(senderId: string, input: NewFamilyMessage): Promise<FamilyMessage>;
  sendToLabel(
    senderId: string,
    input: { toLabel: string; text: string },
  ): Promise<FamilyMessage | null>;
}

export function createFamilyMessenger(deps: FamilyMessengerDeps): FamilyMessenger {
  const send = async (senderId: string, input: NewFamilyMessage) => {
    const sent = await deps.store.send(senderId, input);
    const received = await deps.store.get(input.to, sent.id).catch(() => null);
    if (received) {
      await deps
        .deliver(input.to, toFamilyMessageBlock(received))
        .catch((err: unknown) =>
          deps.logger?.warn({ err }, 'consegna del messaggio in chat non riuscita'),
        );
      if (deps.push) {
        const body = received.text || '📷 Foto';
        await deps
          .push(input.to, {
            title: `✉️ ${received.label}`,
            body: received.image && received.text ? `📷 ${body}` : body,
            data: { kind: 'family_message', id: received.id },
            threadId: `family-${senderId}`,
          })
          .catch((err: unknown) =>
            deps.logger?.warn({ err }, 'notifica del messaggio non riuscita'),
          );
      }
    }
    return sent;
  };
  return {
    send,
    async sendToLabel(senderId, input) {
      const link = await deps.findLink(senderId, input.toLabel);
      if (!link) return null;
      return send(senderId, { to: link.otherUserId, text: input.text });
    },
  };
}

/** Tool per il modello: messaggi in forma libera («di' a Giorgio di venire a cena» → «Vieni a cena!»). */
export function createFamilyMessageTool(messenger: FamilyMessenger) {
  return defineTool({
    id: 'family_message_send',
    version: '1',
    category: 'family',
    description:
      "Manda un messaggio a una persona collegata in Famiglia (arriva nella sua chat con una notifica). Usalo quando l'utente chiede di scrivere, dire o mandare qualcosa a un familiare collegato («di' a Giorgio di venire a cena», «avvisa papà che arrivo tardi»). `text` è il messaggio così come lo leggerà la persona, rivolto a lei in seconda persona («Vieni a cena!»), breve e senza aggiungere altro. `to` è l'etichetta con cui l'utente la chiama. Non usarlo per i promemoria a un'ora precisa (quelli sono reminder_create con forLabel).",
    risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: true, write: true },
    timeoutMs: 8_000,
    inputSchema: z.object({
      to: z
        .string()
        .min(1)
        .max(60)
        .describe('Etichetta della persona collegata, es. «Giorgio», «papà»'),
      text: z
        .string()
        .min(1)
        .max(2000)
        .describe('Il messaggio rivolto alla persona, in seconda persona'),
    }),
    outputSchema: z.object({ id: z.string(), to: z.string() }),
    execute: async (input, ctx) => {
      const m = await messenger.sendToLabel(ctx.userId, { toLabel: input.to, text: input.text });
      if (!m)
        throw new ToolError(
          `Nessuna persona collegata si chiama «${input.to}»: chiedi all’utente di collegarla da Impostazioni › Famiglia.`,
          'invalid_input',
        );
      lastSent.set(m.id, m);
      if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value as string);
      return { id: m.id, to: m.label };
    },
    present: (_input, out) => {
      const m = lastSent.get(out.id);
      return m ? toFamilyMessageBlock(m) : null;
    },
  });
}

const lastSent = new Map<string, FamilyMessage>();
