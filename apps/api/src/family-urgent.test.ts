import { describe, expect, it } from 'vitest';
import {
  createFamilyMessenger,
  type FamilyMessage,
  type FamilyMessageStore,
  type FamilyPush,
  UrgentNotAllowedError,
} from './family-messages.js';

const PAPA = 'papa';
const GIORGIO = 'giorgio';

/** Store in memoria: un messaggio urgente da papà a Giorgio, visto da ciascuno con il proprio nome per l'altro. */
function fakeStore() {
  const row = {
    id: 'm1',
    sender: PAPA,
    recipient: GIORGIO,
    text: 'Torna a casa',
    urgent: true,
    ack: null as Date | null,
  };
  const view = (viewer: string): FamilyMessage => ({
    id: row.id,
    direction: viewer === row.sender ? 'out' : 'in',
    otherUserId: viewer === row.sender ? row.recipient : row.sender,
    label: viewer === row.sender ? 'Giorgio' : 'papo',
    text: row.text,
    image: null,
    replyTo: null,
    at: new Date('2026-10-15T20:00:00Z'),
    readAt: row.ack,
    urgent: row.urgent,
    acknowledgedAt: row.ack,
  });
  let due = [{ id: 'm1', senderId: PAPA, recipientId: GIORGIO, count: 1 }];
  let expired = [] as { id: string; senderId: string; recipientId: string }[];
  const store: FamilyMessageStore = {
    send: async (senderId) => view(senderId),
    get: async (userId) => view(userId),
    list: async () => [],
    image: async () => null,
    markRead: async () => 0,
    acknowledge: async (userId) => {
      if (userId !== row.recipient || row.ack) return false;
      row.ack = new Date('2026-10-15T20:05:00Z');
      return true;
    },
    urgentDue: async () => {
      const d = due;
      due = [];
      return d;
    },
    urgentExpired: async () => {
      const e = expired;
      expired = [];
      return e;
    },
  };
  return {
    store,
    row,
    expire: () => {
      expired = [{ id: 'm1', senderId: PAPA, recipientId: GIORGIO }];
    },
  };
}

function setup(relation: string | null = 'figlio') {
  const s = fakeStore();
  const pushes: { to: string; msg: FamilyPush }[] = [];
  const delivered: { to: string; block: { acknowledgedAt?: string; direction: string } }[] = [];
  const messenger = createFamilyMessenger({
    store: s.store,
    findLink: async () => ({ otherUserId: GIORGIO, label: 'Giorgio' }),
    deliver: async (to, block) => {
      delivered.push({ to, block });
    },
    push: async (to, msg) => {
      pushes.push({ to, msg });
    },
    relationOf: async () => relation,
  });
  return { ...s, messenger, pushes, delivered };
}

describe('messaggi urgenti («super snooze»)', () => {
  it('solo a un figlio', async () => {
    const { messenger } = setup('genitore');
    await expect(
      messenger.send(PAPA, { to: GIORGIO, text: 'Vieni', urgent: true }),
    ).rejects.toBeInstanceOf(UrgentNotAllowedError);
    const ok = setup('figlio');
    await expect(
      ok.messenger.send(PAPA, { to: GIORGIO, text: 'Vieni', urgent: true }),
    ).resolves.toMatchObject({ urgent: true });
    expect(ok.pushes[0]?.msg).toMatchObject({ category: 'FAMILY_URGENT', collapseId: 'm1' });
  });

  it('si ripete finché non arriva la conferma; la conferma va al genitore e ferma le ripetizioni', async () => {
    const t = setup();
    expect(await t.messenger.nag()).toEqual({ repeated: 1, expired: 0 });
    expect(t.pushes.at(-1)).toMatchObject({ to: GIORGIO, msg: { title: '🚨 Urgente da papo' } });
    // Solo chi riceve conferma.
    expect(await t.messenger.acknowledge(PAPA, 'm1')).toBeNull();
    const m = await t.messenger.acknowledge(GIORGIO, 'm1');
    expect(m?.acknowledgedAt).toEqual(new Date('2026-10-15T20:05:00Z'));
    expect(t.pushes.at(-1)).toMatchObject({ to: PAPA, msg: { title: '✓ Giorgio ha letto' } });
    expect(t.delivered.map((d) => [d.to, d.block.direction, d.block.acknowledgedAt])).toEqual([
      [PAPA, 'out', '2026-10-15T20:05:00.000Z'],
      [GIORGIO, 'in', '2026-10-15T20:05:00.000Z'],
    ]);
    // Seconda conferma: niente di nuovo per il genitore.
    const before = t.pushes.length;
    await t.messenger.acknowledge(GIORGIO, 'm1');
    expect(t.pushes.length).toBe(before);
  });

  it("dopo un'ora senza conferma smette e lo dice al genitore", async () => {
    const t = setup();
    await t.messenger.nag();
    t.expire();
    expect(await t.messenger.nag()).toEqual({ repeated: 0, expired: 1 });
    expect(t.pushes.at(-1)).toMatchObject({
      to: PAPA,
      msg: { title: '⏳ Giorgio non ha ancora confermato' },
    });
  });
});
