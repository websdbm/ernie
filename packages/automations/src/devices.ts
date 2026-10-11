import { type Pool, withUser } from '@ernie/db';
import { z } from 'zod';

export const DeviceInput = z.object({
  platform: z.literal('ios'),
  /** Token APNs in esadecimale (64 o più caratteri). */
  token: z.string().regex(/^[0-9a-fA-F]{32,512}$/),
  environment: z.enum(['development', 'production']).default('development'),
  appVersion: z.string().max(64).optional(),
  locale: z.string().max(16).optional(),
});
export type DeviceInput = z.infer<typeof DeviceInput>;

export interface Device {
  readonly id: string;
  readonly userId: string;
  readonly platform: 'ios';
  readonly token: string;
  readonly environment: 'development' | 'production';
  readonly appVersion: string | null;
  readonly locale: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

interface Row {
  id: string;
  user_id: string;
  platform: 'ios';
  token: string;
  environment: Device['environment'];
  app_version: string | null;
  locale: string | null;
  created_at: Date;
  last_seen_at: Date;
}
const COLS = `id, user_id, platform, token, environment, app_version, locale, created_at, last_seen_at`;
const toDevice = (r: Row): Device => ({
  id: r.id,
  userId: r.user_id,
  platform: r.platform,
  token: r.token.toLowerCase(),
  environment: r.environment,
  appVersion: r.app_version,
  locale: r.locale,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export interface DeviceRepository {
  /** Registra o aggiorna il dispositivo; se il token apparteneva a un altro utente, lo riassegna. */
  register(userId: string, input: DeviceInput): Promise<Device>;
  remove(userId: string, token: string): Promise<boolean>;
  list(userId: string): Promise<Device[]>;
}

export function createDeviceRepository(pool: Pool): DeviceRepository {
  return {
    async register(userId, input) {
      const token = input.token.toLowerCase();
      return withUser(pool, userId, async (client) => {
        const mine = await client.query<Row>(
          `INSERT INTO devices (user_id, platform, token, environment, app_version, locale)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (platform, token) DO UPDATE
             SET environment = EXCLUDED.environment, app_version = EXCLUDED.app_version, locale = EXCLUDED.locale, last_seen_at = now()
           WHERE devices.user_id = EXCLUDED.user_id
           RETURNING ${COLS}`,
          [
            userId,
            input.platform,
            token,
            input.environment,
            input.appVersion ?? null,
            input.locale ?? null,
          ],
        );
        const row = mine.rows[0];
        if (row) return toDevice(row);
        // Conflitto con la riga di un altro utente (invisibile per RLS): liberata e reinserita.
        await client.query(`SELECT device_release_token($1, $2)`, [input.platform, token]);
        const again = await client.query<Row>(
          `INSERT INTO devices (user_id, platform, token, environment, app_version, locale)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
          [
            userId,
            input.platform,
            token,
            input.environment,
            input.appVersion ?? null,
            input.locale ?? null,
          ],
        );
        const r2 = again.rows[0];
        if (!r2) throw new Error('registrazione dispositivo fallita');
        return toDevice(r2);
      });
    },
    async remove(userId, token) {
      return withUser(
        pool,
        userId,
        async (client) =>
          (
            await client.query(`DELETE FROM devices WHERE user_id = $1 AND token = $2`, [
              userId,
              token.toLowerCase(),
            ])
          ).rowCount === 1,
      );
    },
    async list(userId) {
      return withUser(pool, userId, async (client) =>
        (
          await client.query<Row>(
            `SELECT ${COLS} FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
            [userId],
          )
        ).rows.map(toDevice),
      );
    },
  };
}
