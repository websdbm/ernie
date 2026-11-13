import { type Pool, withUser } from '@ernie/db';
import type { z } from 'zod';
import type { HealthCipher } from '../health-protection/crypto.js';
import {
  type McpRead,
  RaindropError,
  type RaindropProvider,
  type Save,
  type Search,
  Token,
} from './provider.js';

export interface ConnectionRecord {
  envelope: unknown;
  updatedAt: string;
}
export interface RaindropStore {
  get(userId: string): Promise<ConnectionRecord | null>;
  put(userId: string, envelope: unknown): Promise<void>;
  remove(userId: string): Promise<void>;
}
export function createRaindropStore(pool: Pool): RaindropStore {
  return {
    get: (userId) =>
      withUser(pool, userId, async (c) => {
        const row = (
          await c.query<{ envelope: unknown; updated_at: Date }>(
            'SELECT envelope, updated_at FROM raindrop_connections WHERE user_id=$1',
            [userId],
          )
        ).rows[0];
        return row ? { envelope: row.envelope, updatedAt: row.updated_at.toISOString() } : null;
      }),
    put: (userId, envelope) =>
      withUser(pool, userId, async (c) => {
        await c.query(
          'INSERT INTO raindrop_connections(user_id,envelope) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET envelope=EXCLUDED.envelope, updated_at=now()',
          [userId, JSON.stringify(envelope)],
        );
      }),
    remove: (userId) =>
      withUser(pool, userId, async (c) => {
        await c.query('DELETE FROM raindrop_connections WHERE user_id=$1', [userId]);
      }),
  };
}
const context = (userId: string) => ({
  userId,
  resourceKind: 'raindrop_connection',
  resourceId: 'account',
  resourceVersion: 1,
});
export interface RaindropStatus {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  account: { id: number; name: string; pro: boolean } | null;
  connectedAt: string | null;
}
export function createRaindropService(deps: {
  store: RaindropStore;
  cipher: HealthCipher | null;
  provider: RaindropProvider;
  canUse(userId: string): Promise<boolean>;
}) {
  const active = new Map<string, Set<AbortController>>();
  const writes = new Map<string, Promise<unknown>>();
  const mutate = async <T>(userId: string, run: () => Promise<T>): Promise<T> => {
    const previous = writes.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    writes.set(userId, next);
    try {
      return await next;
    } finally {
      if (writes.get(userId) === next) writes.delete(userId);
    }
  };
  const pause = (userId: string) => {
    for (const c of active.get(userId) ?? []) c.abort();
    active.delete(userId);
  };
  const requireEnabled = async (userId: string) => {
    if (!(await deps.canUse(userId)))
      throw new RaindropError(
        'skill_disabled',
        'Attiva la skill Raindrop per usare la tua raccolta.',
        403,
      );
  };
  const operation = async <T>(
    userId: string,
    signal: AbortSignal | undefined,
    run: (s: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const list = active.get(userId) ?? new Set<AbortController>();
    list.add(controller);
    active.set(userId, list);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    try {
      return await run(combined);
    } finally {
      list.delete(controller);
      if (!list.size && active.get(userId) === list) active.delete(userId);
    }
  };
  const checkActive = (signal: AbortSignal) => {
    if (signal.aborted)
      throw new RaindropError(
        'connection_changed',
        'Collegamento Raindrop cambiato: ripeti la richiesta.',
        409,
      );
  };
  const cipher = () => {
    if (!deps.cipher)
      throw new RaindropError(
        'not_configured',
        'Il collegamento Raindrop non è ancora configurato su questo server.',
        503,
      );
    return deps.cipher;
  };
  const decode = (userId: string, record: ConnectionRecord) => {
    try {
      const bytes = cipher().decrypt(context(userId), record.envelope);
      try {
        const p = JSON.parse(bytes.toString()) as {
          token: string;
          account: { id: number; name: string; pro: boolean };
        };
        return {
          token: Token.parse(p.token),
          account: { id: p.account.id, name: p.account.name, pro: p.account.pro },
        };
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw new RaindropError(
        'connection_unavailable',
        'Ricollega l’account Raindrop: la credenziale protetta non è disponibile.',
        503,
      );
    }
  };
  const withToken = async <T>(
    userId: string,
    signal: AbortSignal | undefined,
    run: (token: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    operation(userId, signal, async (combined) => {
      await requireEnabled(userId);
      const record = await deps.store.get(userId);
      if (!record)
        throw new RaindropError(
          'not_connected',
          'Collega il tuo account in Impostazioni → Raindrop.',
          409,
        );
      const credential = decode(userId, record);
      checkActive(combined);
      const result = await run(credential.token, combined);
      await requireEnabled(userId);
      const current = await deps.store.get(userId);
      if (
        combined.aborted ||
        !current ||
        JSON.stringify(current.envelope) !== JSON.stringify(record.envelope)
      )
        throw new RaindropError(
          'connection_changed',
          'Collegamento Raindrop cambiato: ripeti la ricerca.',
          409,
        );
      return result;
    });
  return {
    pause,
    async status(userId: string): Promise<RaindropStatus> {
      const enabled = await deps.canUse(userId);
      const record = await deps.store.get(userId);
      const account = record && deps.cipher ? decode(userId, record).account : null;
      return {
        configured: !!deps.cipher,
        enabled,
        connected: !!account,
        account,
        connectedAt: record?.updatedAt ?? null,
      };
    },
    async connect(userId: string, input: string, signal?: AbortSignal) {
      pause(userId);
      return operation(userId, signal, async (combined) => {
        await requireEnabled(userId);
        const key = cipher();
        const token = Token.parse(input);
        checkActive(combined);
        // Validate by reading /user only; do not import or mutate the remote library.
        const account = await deps.provider.account(token, combined);
        await mutate(userId, async () => {
          await requireEnabled(userId);
          checkActive(combined);
          const bytes = Buffer.from(JSON.stringify({ token, account }));
          try {
            await deps.store.put(userId, key.encrypt(context(userId), bytes));
          } finally {
            bytes.fill(0);
          }
        });
        checkActive(combined);
        return this.status(userId);
      });
    },
    async disconnect(userId: string) {
      pause(userId);
      await mutate(userId, () => deps.store.remove(userId));
      return this.status(userId);
    },
    search: (userId: string, input: z.infer<typeof Search>, signal?: AbortSignal) =>
      withToken(userId, signal, (t, s) => deps.provider.search(t, input, s)),
    get: (userId: string, id: number, signal?: AbortSignal) =>
      withToken(userId, signal, (t, s) => deps.provider.get(t, id, s)),
    collections: (userId: string, signal?: AbortSignal) =>
      withToken(userId, signal, (t, s) => deps.provider.collections(t, s)),
    save: (userId: string, input: z.infer<typeof Save>, signal?: AbortSignal) =>
      withToken(userId, signal, (t, s) => deps.provider.save(t, input, s)),
    readTools: (userId: string, signal?: AbortSignal) =>
      withToken(userId, signal, (t, s) => deps.provider.readTools(t, s)),
    read: (userId: string, input: z.infer<typeof McpRead>, signal?: AbortSignal) =>
      withToken(userId, signal, (t, s) => deps.provider.read(t, input, s)),
  };
}
export type RaindropService = ReturnType<typeof createRaindropService>;
