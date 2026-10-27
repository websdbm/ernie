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
  /** «Super snooze» (0034): suona finché chi riceve non conferma di averlo letto. */
  readonly urgent: boolean;
  readonly acknowledgedAt: Date | null;
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
  readonly urgent?: boolean;
}

export class NotLinkedError extends Error {
  constructor() {
    super('la persona non è collegata in Famiglia');
    this.name = 'NotLinkedError';
  }
}

/** Urgente solo da un genitore a un figlio (relazione «figlio» nel collegamento di chi scrive). */
export class UrgentNotAllowedError extends Error {
  constructor() {
    super('i messaggi urgenti si mandano solo ai figli');
    this.name = 'UrgentNotAllowedError';
  }
}

export interface UrgentDue {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly count: number;
}

export interface FamilyMessageStore {
  send(senderId: string, input: NewFamilyMessage): Promise<FamilyMessage>;
  /** Visto da `userId`: lo stesso messaggio come «out» per chi l'ha scritto e «in» per chi lo riceve. */
  get(userId: string, id: string): Promise<FamilyMessage | null>;
  /** Messaggi miei (inviati e ricevuti), dal più vecchio; `since` esclusivo. */
  list(userId: string, opts?: { since?: Date; limit?: number }): Promise<FamilyMessage[]>;
  image(userId: string, id: string): Promise<FamilyMessageImage | null>;
  markRead(userId: string, ids: readonly string[]): Promise<number>;
  /** Conferma di lettura di un urgente da parte di chi lo riceve; false se non c'era niente da confermare. */
  acknowledge(userId: string, id: string): Promise<boolean>;
  /** Ripetizioni dovute degli urgenti non confermati (fuori dalla RLS, già segnate come fatte). */
  urgentDue(): Promise<UrgentDue[]>;
  /** Urgenti non confermati dopo un'ora: smettono di suonare (una volta sola). */
  urgentExpired(): Promise<Omit<UrgentDue, 'count'>[]>;
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
  urgent: boolean;
  acknowledged_at: Date | null;
}

const COLS = `m.id, m.sender_id, m.recipient_id, m.body, m.reply_to, (m.image_mime IS NOT NULL) AS has_image,
  m.image_w, m.image_h, m.created_at, m.read_at, l.label, m.urgent, m.acknowledged_at`;
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
    urgent: r.urgent,
    acknowledgedAt: r.acknowledged_at,
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
            `INSERT INTO family_messages (sender_id, recipient_id, body, reply_to, image_mime, image_bytes, image_w, image_h, urgent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              senderId,
              input.to,
              input.text.trim(),
              input.replyTo ?? null,
              input.image?.mime ?? null,
              input.image?.bytes ?? null,
              input.image?.width ?? null,
              input.image?.height ?? null,
              input.urgent === true,
            ],
          );
          return r.rows[0]?.id;
        } catch (err) {
          // 42501: la policy rifiuta l'inserimento (persona non collegata, o urgente a chi non è un figlio).
          if ((err as { code?: string }).code === '42501')
            throw input.urgent ? new UrgentNotAllowedError() : new NotLinkedError();
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
    async acknowledge(userId, id) {
      return withUser(pool, userId, async (c) => {
        const r = await c.query(
          `UPDATE family_messages SET acknowledged_at = now(), read_at = COALESCE(read_at, now())
            WHERE id = $2 AND recipient_id = $1 AND urgent AND acknowledged_at IS NULL`,
          [userId, id],
        );
        return (r.rowCount ?? 0) > 0;
      });
    },
    async urgentDue() {
      const r = await pool.query<{
        o_id: string;
        o_sender: string;
        o_recipient: string;
        o_count: number;
      }>(`SELECT * FROM family_urgent_due()`);
      return r.rows.map((x) => ({
        id: x.o_id,
        senderId: x.o_sender,
        recipientId: x.o_recipient,
        count: x.o_count,
      }));
    },
    async urgentExpired() {
      const r = await pool.query<{ o_id: string; o_sender: string; o_recipient: string }>(
        `SELECT * FROM family_urgent_expired()`,
      );
      return r.rows.map((x) => ({ id: x.o_id, senderId: x.o_sender, recipientId: x.o_recipient }));
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
    ...(m.urgent ? { urgent: true as const } : {}),
    ...(m.acknowledgedAt ? { acknowledgedAt: m.acknowledgedAt.toISOString() } : {}),
  };
}

/**
 * Notifica di un messaggio (richiesta dell'utente, 15 ott 2026: «ben evidenti sul lock screen»): urgente, così resta
 * in cima alla schermata di blocco; categoria con «Rispondi»; i dati servono all'estensione dell'app per mostrarla
 * come un messaggio (nome e iniziali di chi scrive) con la foto in anteprima.
 */
export interface FamilyPush {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly threadId: string;
  readonly interruptionLevel?: 'time-sensitive';
  readonly category?: 'FAMILY_MESSAGE' | 'FAMILY_URGENT';
  readonly sound?: string;
  readonly collapseId?: string;
}

/**
 * Notifica di un messaggio per chi lo riceve. Gli urgenti hanno titolo e suono propri e si ripetono sostituendo la
 * precedente (stesso identificativo), finché non arriva la conferma di lettura.
 */
export function familyPush(received: FamilyMessage, nag?: number): FamilyPush {
  const body = received.text || '📷 Foto';
  return {
    title: received.urgent ? `🚨 Urgente da ${received.label}` : `✉️ ${received.label}`,
    ...(received.urgent ? { subtitle: 'Aprilo e conferma di averlo letto' } : {}),
    body: received.image && received.text ? `📷 ${body}` : body,
    data: {
      kind: 'family_message',
      id: received.id,
      from: received.otherUserId,
      label: received.label,
      image: received.image !== null,
      ...(received.urgent ? { urgent: true } : {}),
      // Ripetizione di un urgente: il telefono non ricarica il widget ogni volta.
      ...(nag ? { nag } : {}),
    },
    threadId: `family-${received.otherUserId}`,
    interruptionLevel: 'time-sensitive',
    category: received.urgent ? 'FAMILY_URGENT' : 'FAMILY_MESSAGE',
    ...(received.urgent ? { sound: 'urgente.caf', collapseId: received.id } : {}),
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
  readonly push?: (userId: string, msg: FamilyPush) => Promise<unknown>;
  /** Cosa è per me l'altra persona («figlio», «genitore»…): gli urgenti solo ai figli. */
  readonly relationOf?: (userId: string, otherUserId: string) => Promise<string | null>;
  readonly logger?: { warn(obj: unknown, msg: string): void };
}

export interface FamilyMessenger {
  /** Salva, consegna (scheda e notifica) e restituisce il messaggio visto da chi scrive. */
  send(senderId: string, input: NewFamilyMessage): Promise<FamilyMessage>;
  sendToLabel(
    senderId: string,
    input: { toLabel: string; text: string; urgent?: boolean },
  ): Promise<FamilyMessage | null>;
  /** Stesso testo già mandato alla stessa persona di recente (contro i doppioni del modello). */
  recentSame(
    senderId: string,
    input: { toLabel: string; text: string },
    withinMs?: number,
  ): Promise<FamilyMessage | null>;
  /** Conferma di lettura di un urgente: lo dice al genitore (scheda aggiornata e notifica). Nil se non c'era. */
  acknowledge(userId: string, id: string): Promise<FamilyMessage | null>;
  /** Un giro delle ripetizioni: notifiche degli urgenti non confermati e avviso al genitore per i scaduti. */
  nag(): Promise<{ repeated: number; expired: number }>;
}

export function createFamilyMessenger(deps: FamilyMessengerDeps): FamilyMessenger {
  const warn = (err: unknown, msg: string) => deps.logger?.warn({ err }, msg);
  const send = async (senderId: string, input: NewFamilyMessage) => {
    if (input.urgent && deps.relationOf && (await deps.relationOf(senderId, input.to)) !== 'figlio')
      throw new UrgentNotAllowedError();
    const sent = await deps.store.send(senderId, input);
    const received = await deps.store.get(input.to, sent.id).catch(() => null);
    if (received) {
      await deps
        .deliver(input.to, toFamilyMessageBlock(received))
        .catch((err: unknown) =>
          deps.logger?.warn({ err }, 'consegna del messaggio in chat non riuscita'),
        );
      if (deps.push) {
        await deps
          .push(input.to, familyPush(received))
          .catch((err: unknown) =>
            deps.logger?.warn({ err }, 'notifica del messaggio non riuscita'),
          );
      }
    }
    return sent;
  };
  return {
    send,
    async recentSame(senderId, input, withinMs = 12 * 3_600_000) {
      const link = await deps.findLink(senderId, input.toLabel);
      if (!link) return null;
      const key = sameText(input.text);
      const recent = await deps.store.list(senderId, {
        since: new Date(Date.now() - withinMs),
        limit: 200,
      });
      return (
        recent
          .filter((m) => m.direction === 'out' && m.otherUserId === link.otherUserId)
          .reverse()
          .find((m) => sameText(m.text) === key) ?? null
      );
    },
    async sendToLabel(senderId, input) {
      const link = await deps.findLink(senderId, input.toLabel);
      if (!link) return null;
      return send(senderId, {
        to: link.otherUserId,
        text: input.text,
        ...(input.urgent ? { urgent: true } : {}),
      });
    },
    async acknowledge(userId, id) {
      const before = await deps.store.get(userId, id);
      if (before?.direction !== 'in' || !before.urgent) return null;
      if (before.acknowledgedAt) return before;
      await deps.store.acknowledge(userId, id);
      const mine = await deps.store.get(userId, id);
      const theirs = await deps.store.get(before.otherUserId, id).catch(() => null);
      if (theirs) {
        await deps
          .deliver(before.otherUserId, toFamilyMessageBlock(theirs))
          .catch((err: unknown) => warn(err, 'conferma di lettura non consegnata in chat'));
        await deps
          .push?.(before.otherUserId, {
            title: `✓ ${theirs.label} ha letto`,
            body: `Ha confermato il messaggio urgente: «${(theirs.text || '📷 Foto').slice(0, 120)}»`,
            data: { kind: 'family_ack', id },
            threadId: `family-${userId}`,
          })
          .catch((err: unknown) => warn(err, 'notifica della conferma non riuscita'));
      }
      // Anche gli altri telefoni di chi conferma smettono di mostrarlo come da confermare.
      if (mine)
        await deps
          .deliver(userId, toFamilyMessageBlock(mine))
          .catch((err: unknown) => warn(err, 'conferma non consegnata in chat'));
      return mine;
    },
    async nag() {
      let repeated = 0;
      for (const due of await deps.store.urgentDue()) {
        const received = await deps.store.get(due.recipientId, due.id).catch(() => null);
        if (!received || received.acknowledgedAt) continue;
        await deps
          .push?.(due.recipientId, familyPush(received, due.count))
          .catch((err: unknown) => warn(err, 'ripetizione del messaggio urgente non riuscita'));
        repeated++;
      }
      let expired = 0;
      for (const gone of await deps.store.urgentExpired()) {
        const theirs = await deps.store.get(gone.senderId, gone.id).catch(() => null);
        if (!theirs) continue;
        await deps
          .push?.(gone.senderId, {
            title: `⏳ ${theirs.label} non ha ancora confermato`,
            body: `Il messaggio urgente ha suonato per un'ora: «${(theirs.text || '📷 Foto').slice(0, 120)}»`,
            data: { kind: 'family_unacknowledged', id: gone.id },
            threadId: `family-${gone.recipientId}`,
          })
          .catch((err: unknown) => warn(err, 'avviso di mancata conferma non riuscito'));
        expired++;
      }
      return { repeated, expired };
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
      urgent: z
        .boolean()
        .optional()
        .describe(
          'Urgente («super snooze»): il telefono suona finché non conferma di averlo letto. Solo se l’utente lo chiede esplicitamente («urgente», «deve leggerlo subito») e solo verso un figlio.',
        ),
      resend: z
        .boolean()
        .optional()
        .describe(
          'true solo se l’utente, nel messaggio attuale, chiede di rimandare un messaggio già partito',
        ),
    }),
    outputSchema: z.object({ id: z.string(), to: z.string(), notice: z.string() }),
    execute: async (input, ctx) => {
      // Il 16 ott 2026 il modello ha rimandato da solo un urgente partito ore prima (l'aveva mandato la skill e
      // nella cronologia non c'era traccia dello strumento): lo stesso testo alla stessa persona entro 12 ore
      // riparte solo se l'utente lo chiede adesso.
      if (!input.resend) {
        const dup = await messenger.recentSame(ctx.userId, { toLabel: input.to, text: input.text });
        if (dup) {
          const at = new Intl.DateTimeFormat('it-IT', {
            timeZone: 'Europe/Rome',
            hour: '2-digit',
            minute: '2-digit',
          }).format(dup.at);
          throw new ToolError(
            `Questo messaggio a ${dup.label} è già partito alle ${at}${dup.urgent ? ' come urgente' : ''}${dup.acknowledgedAt ? ' ed è stato confermato' : ''}: non rimandarlo. Dillo all’utente; rimandalo (resend true) solo se è lui a chiederlo esplicitamente nel messaggio attuale.`,
            'invalid_input',
          );
        }
      }
      let m: FamilyMessage | null;
      try {
        m = await messenger.sendToLabel(ctx.userId, {
          toLabel: input.to,
          text: input.text,
          ...(input.urgent ? { urgent: true } : {}),
        });
      } catch (err) {
        if (err instanceof UrgentNotAllowedError)
          throw new ToolError(
            `I messaggi urgenti si mandano solo ai figli: «${input.to}» non è un figlio dell’utente. Mandalo come messaggio normale se l’utente è d’accordo.`,
            'invalid_input',
          );
        throw err;
      }
      if (!m)
        throw new ToolError(
          `Nessuna persona collegata si chiama «${input.to}»: chiedi all’utente di collegarla da Impostazioni › Famiglia.`,
          'invalid_input',
        );
      lastSent.set(m.id, m);
      if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value as string);
      return {
        id: m.id,
        to: m.label,
        notice:
          `Invio riuscito${m.urgent ? ' come urgente' : ''}. La scheda mostra gia destinatario, testo e stato: ` +
          'rispondi con una sola frase breve di conferma dell’invio, senza ripetere il contenuto. ' +
          'Non affermare che il telefono stia suonando o che il messaggio sia stato consegnato o letto: ' +
          'la conferma esplicita di lettura compare nella scheda quando arriva.',
      };
    },
    present: (_input, out) => {
      const m = lastSent.get(out.id);
      return m ? toFamilyMessageBlock(m) : null;
    },
  });
}

const lastSent = new Map<string, FamilyMessage>();

/** Testo confrontabile: minuscolo, senza punteggiatura né spazi doppi («Facciamo colazione!» = «facciamo colazione»). */
export function sameText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
