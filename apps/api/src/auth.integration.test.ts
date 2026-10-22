import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthenticator, generateApiKey } from './auth.js';
import { createUserBudgetCheck } from './user-budget.js';

const ownerUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
describe.skipIf(!ownerUrl || !appUrl)(
  'autorizzazione e budget aggiornati con Postgres e RLS',
  () => {
    let owner: Pool;
    let app: Pool;
    const userId = randomUUID();
    const apiKeyId = randomUUID();
    const key = generateApiKey();
    beforeAll(async () => {
      owner = createPool({ connectionString: ownerUrl as string, max: 2 });
      app = createPool({ connectionString: appUrl as string, max: 2 });
      await owner.query(
        "INSERT INTO users (id, display_name, role) VALUES ($1, 'Review auth', 'member')",
        [userId],
      );
      await owner.query(
        "INSERT INTO api_keys (id, user_id, label, key_hash, scopes) VALUES ($1, $2, 'review', $3, ARRAY['chat'])",
        [apiKeyId, userId, key.hash],
      );
    });
    afterAll(async () => {
      await owner.query('DELETE FROM users WHERE id = $1', [userId]);
      await Promise.all([owner.end(), app.end()]);
    });
    it('rilegge impostazioni e revoca senza conservare la chiave in chiaro', async () => {
      const authenticator = createAuthenticator(app);
      const auth = await authenticator.authenticate(key.key);
      expect(auth?.userId).toBe(userId);
      if (!auth) throw new Error('autenticazione assente');
      await owner.query(
        'UPDATE users SET settings = \'{"killSwitch":true}\'::jsonb WHERE id = $1',
        [userId],
      );
      expect((await authenticator.refresh(auth))?.settings.killSwitch).toBe(true);
      expect(await authenticator.refresh({ ...auth, userId: randomUUID() })).toBeNull();
      await owner.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [apiKeyId]);
      expect(await authenticator.refresh(auth)).toBeNull();
      expect(await authenticator.authenticate(key.key)).toBeNull();
    });
    it('mantiene il limite personale con server illimitato, rilegge la spesa e rispetta la pausa', async () => {
      const check = createUserBudgetCheck(app, 0);
      await owner.query(
        'UPDATE users SET settings = \'{"dailyBudgetUsd":0.1}\'::jsonb WHERE id = $1',
        [userId],
      );
      await expect(check(userId)).resolves.toBeUndefined();
      await owner.query(
        "INSERT INTO llm_calls (user_id, request_id, provider, model, cost_estimated_usd) VALUES ($1, 'review-budget', 'test', 'test', 0.1)",
        [userId],
      );
      await expect(check(userId)).rejects.toThrow('budget giornaliero');
      await owner.query(
        'UPDATE users SET settings = \'{"dailyBudgetUsd":0.5}\'::jsonb WHERE id = $1',
        [userId],
      );
      await expect(check(userId)).resolves.toBeUndefined();
      await owner.query(
        'UPDATE users SET settings = settings || \'{"killSwitch":true}\'::jsonb WHERE id = $1',
        [userId],
      );
      await expect(check(userId)).rejects.toThrow('in pausa');
    });
  },
);
