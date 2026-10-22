import { randomUUID } from 'node:crypto';
import { loadConfig } from '@ernie/config';
import { createPool, type Pool, withUser } from '@ernie/db';
import { createBudgetGuard } from '@ernie/model-gateway';
import { createLogger } from '@ernie/observability';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthenticator, generateApiKey } from './auth.js';
import { type AppServer, buildServer } from './server.js';
import { createUsageService, UsageQuery, type UsageReport } from './usage.js';

const ownerUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;

describe.skipIf(!ownerUrl || !appUrl)('consumi: Postgres reale, RLS e REST', () => {
  let owner: Pool;
  let pool: Pool;
  let server: AppServer;
  let service: ReturnType<typeof createUsageService>;
  const adminId = randomUUID();
  const otherId = randomUUID();
  const emptyId = randomUUID();
  const cliId = randomUUID();
  const testId = randomUUID();
  const fixtureIds = [adminId, otherId, emptyId, cliId, testId];
  const keys = new Map<string, ReturnType<typeof generateApiKey>>(
    fixtureIds.map((id) => [id, generateApiKey()]),
  );
  const balance = vi.fn(async () => ({
    provider: 'openrouter' as const,
    status: 'available' as const,
    checkedAt: '2026-10-20T12:00:00.000Z',
    balanceUsd: 0.2,
  }));
  const query = (extra: Record<string, unknown> = {}) =>
    UsageQuery.parse({ period: 'day', date: '2026-10-20', timezone: 'Europe/Rome', ...extra });
  const headers = (id: string) => ({ authorization: `Bearer ${keys.get(id)?.key}` });
  const report = (id = adminId, extra: Record<string, unknown> = {}, all = false) =>
    service.report(id, query(extra), all);

  async function call(
    userId: string,
    at: string,
    amount: number,
    reported: boolean,
    model = 'anthropic/claude-sonnet-5.5',
  ) {
    return (
      await owner.query<{ id: string }>(
        `INSERT INTO llm_calls
          (user_id,request_id,provider,model,purpose,input_tokens,output_tokens,
           cost_reported_usd,cost_estimated_usd,created_at)
         VALUES($1,$2,'anthropic',$3,'turn',100,10,$4,$5,$6) RETURNING id`,
        [userId, randomUUID(), model, reported ? amount : null, reported ? 9 : amount, at],
      )
    ).rows[0]?.id;
  }

  beforeAll(async () => {
    owner = createPool({ connectionString: ownerUrl as string, max: 2 });
    pool = createPool({ connectionString: appUrl as string, max: 3 });
    for (const [id, name, role] of [
      [adminId, 'Amministratore consumi', 'owner'],
      [otherId, 'Altro proprietario', 'owner'],
      [emptyId, 'Installazione vuota', 'member'],
      [cliId, 'Account tecnico', 'owner'],
      [testId, 'Simulatore di collaudo', 'member'],
    ]) {
      await owner.query(
        'INSERT INTO users(id,display_name,role,companion_name) VALUES($1,$2,$3,$4)',
        [id, name, role, 'Ernie'],
      );
      await owner.query(
        "INSERT INTO api_keys(user_id,label,key_hash,scopes) VALUES($1,'usage-test',$2,ARRAY['chat'])",
        [id, keys.get(id as string)?.hash],
      );
      await owner.query('INSERT INTO sessions(user_id,client_platform) VALUES($1,$2)', [
        id,
        id === cliId ? 'cli' : 'ios',
      ]);
    }
    await owner.query('UPDATE usage_accounts SET is_test=true WHERE user_id=$1', [testId]);
    await owner.query('INSERT INTO usage_admins(user_id) VALUES($1)', [adminId]);
    await call(adminId, '2026-10-20T07:00:00Z', 0.5, true);
    await call(adminId, '2026-10-20T08:00:00Z', 0.02, false, 'fish-audio/drama-3');
    await call(adminId, '2026-10-19T22:00:00Z', 0.25, true);
    await call(adminId, '2026-10-19T21:59:59Z', 1, true);
    await call(adminId, '2026-10-31T23:30:00Z', 0.1, true);
    await call(otherId, '2026-10-20T10:00:00Z', 2, true);
    await call(cliId, '2026-10-20T10:00:00Z', 100, true);
    await call(testId, '2026-10-20T10:00:00Z', 200, true);
    for (const source of ['jev', 'cache', 'deterministic']) {
      await owner.query(
        `INSERT INTO router_decisions(user_id,request_id,source,route,model_class,
          cost_usd,jev_model,created_at) VALUES($1,$2,$3,'llm','standard',0.003,'typesafe/jev-1.13','2026-10-20T08:05:00Z')`,
        [adminId, randomUUID(), source],
      );
    }
    service = createUsageService(pool, () => new Date('2026-10-20T12:00:00Z'));
    const authenticator = createAuthenticator(pool);
    server = await buildServer({
      config: loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      logger: createLogger({ level: 'silent', name: 'usage-test' }),
      checks: {},
      me: {
        authenticator,
        allowedOrigins: [],
        pool,
        version: 'test',
        canViewAllUsage: service.canAdmin,
      },
      usage: { authenticator, allowedOrigins: [], service, providerBalance: balance },
    });
  });

  afterAll(async () => {
    await server?.close();
    if (owner) {
      await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [fixtureIds]);
      // Solo fixture su DB dedicato: la normale cancellazione di account conserva i consumi.
      await owner.query('DELETE FROM usage_ledger WHERE user_id=ANY($1::uuid[])', [fixtureIds]);
      await owner.query('DELETE FROM usage_accounts WHERE user_id=ANY($1::uuid[])', [fixtureIds]);
    }
    await Promise.all([owner?.end(), pool?.end()]);
  });

  it('separa costo riportato e stimato, include Jev una volta e attribuisce il fallback al provider reale', async () => {
    const data = await report();
    expect(data.totals).toMatchObject({ calls: 4, reportedUsd: 0.753, estimatedUsd: 0.02 });
    expect(data.totals.amountUsd).toBeCloseTo(0.773);
    expect(data.series.reduce((n, b) => n + b.amountUsd, 0)).toBeCloseTo(0.773);
    expect(data.byProvider.find((x) => x.id === 'openrouter')?.amountUsd).toBeCloseTo(0.753);
    expect(data.byActivity.find((x) => x.id === 'voice')?.amountUsd).toBe(0.02);
    expect(data.byActivity.find((x) => x.id === 'router')?.calls).toBe(1);
    expect(data.accounts).toBeUndefined();
    expect(data.scope).toBe('personal');
  });

  it('rispetta lunedì, mezzanotte locale e confini mese/anno', async () => {
    const week = await report(adminId, { period: 'week' });
    expect(week.from).toBe('2026-10-18T22:00:00.000Z');
    expect(week.to).toBe('2026-10-25T23:00:00.000Z');
    expect(week.totals.amountUsd).toBeCloseTo(1.773);
    expect(week.series).toHaveLength(7);
    const month = await report(adminId, { period: 'month' });
    expect(month.to).toBe('2026-10-31T23:00:00.000Z');
    expect(month.totals.amountUsd).toBeCloseTo(1.773);
    expect(month.series).toHaveLength(31);
    const year = await report(adminId, { period: 'year' });
    expect(year.series).toHaveLength(12);
    expect(year.totals.amountUsd).toBeCloseTo(1.873);
  });

  it('mantiene 23/25 ore nel cambio legale e il bucket finale con scarto di mezz’ora', async () => {
    expect((await report(adminId, { date: '2026-03-29' })).series).toHaveLength(23);
    const fall = await report(adminId, { date: '2026-10-25' });
    expect(fall.series).toHaveLength(25);
    expect(new Set(fall.series.map((x) => x.date)).size).toBe(25);
    const half = await report(adminId, { date: '2026-10-04', timezone: 'Australia/Lord_Howe' });
    expect(half.series).toHaveLength(24);
    expect(new Date(half.to).getTime() - new Date(half.from).getTime()).toBe(23.5 * 3_600_000);
  });

  it('gli account senza consumi hanno zero reale e bucket completi', async () => {
    const data = await report(emptyId);
    expect(data.totals.amountUsd).toBe(0);
    expect(data.totals.calls).toBe(0);
    expect(data.series).toHaveLength(24);
    expect(data.coverage.since).toBeNull();
    expect(data.byModel).toEqual([]);
  });

  it('solo il permesso dedicato concede la panoramica: essere owner non basta', async () => {
    const me = await server.inject({ method: 'GET', url: '/v1/me', headers: headers(adminId) });
    expect(me.json().capabilities.usageAdmin).toBe(true);
    const other = await server.inject({ method: 'GET', url: '/v1/me', headers: headers(otherId) });
    expect(other.json().role).toBe('owner');
    expect(other.json().capabilities.usageAdmin).toBe(false);
    const denied = await server.inject({
      method: 'GET',
      url: '/v1/usage/admin',
      headers: headers(otherId),
    });
    expect(denied.statusCode).toBe(403);
    expect(balance).not.toHaveBeenCalled();
    const allowed = await server.inject({
      method: 'GET',
      url: '/v1/usage/admin?period=day&date=2026-10-20',
      headers: headers(adminId),
    });
    const data = allowed.json<UsageReport>();
    expect(allowed.statusCode).toBe(200);
    // Il registro conserva anche gli account cancellati da altre suite.
    // Verificare le fixture senza assumere che il database condiviso sia vuoto.
    const fixtureIds: string[] = [adminId, otherId, emptyId];
    const fixtures = data.accounts?.filter((a) => fixtureIds.includes(a.id));
    expect(fixtures).toHaveLength(3);
    expect(fixtures?.reduce((sum, a) => sum + a.amountUsd, 0)).toBeCloseTo(2.773);
    expect(data.accounts?.reduce((sum, a) => sum + a.amountUsd, 0)).toBeCloseTo(
      data.totals.amountUsd,
    );
    expect(data.providerAccount?.balanceUsd).toBe(0.2);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(balance).toHaveBeenCalledTimes(1);
  });

  it('il dettaglio amministrativo è isolato e il pannello personale non accetta altri account', async () => {
    const data = await report(adminId, { accountId: otherId }, true);
    expect(data.scope).toBe('account');
    expect(data.totals.amountUsd).toBe(2);
    expect(data.account?.name).toBe('Altro proprietario');
    expect(data.accounts).toBeUndefined();
    await expect(report(otherId, { accountId: adminId })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(report(otherId, { accountId: adminId }, true)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(report(adminId, { accountId: randomUUID() }, true)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('filtra installazioni, totale, grafico e dettagli insieme; conserva i costi tecnici nel registro', async () => {
    const data = await report(adminId, {}, true);
    expect(data.accounts?.some((a) => a.id === cliId || a.id === testId)).toBe(false);
    expect(data.accounts?.some((a) => a.id === emptyId)).toBe(true); // app senza APNs o consumi
    expect(data.series.reduce((sum, x) => sum + x.amountUsd, 0)).toBeCloseTo(data.totals.amountUsd);
    expect(data.byModel.reduce((sum, x) => sum + x.amountUsd, 0)).toBeCloseTo(
      data.totals.amountUsd,
    );
    expect((await report(cliId)).totals.amountUsd).toBe(100);
    expect((await report(testId)).totals.amountUsd).toBe(200);
    for (const accountId of [cliId, testId]) {
      await expect(report(adminId, { accountId }, true)).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(
      withUser(pool, testId, (c) =>
        c.query('UPDATE usage_accounts SET is_test=false WHERE user_id=$1', [testId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('registra una nuova installazione da APNs e la mantiene dopo revoca del token', async () => {
    await owner.query("INSERT INTO devices(user_id,platform,token) VALUES($1,'ios',$2)", [
      cliId,
      randomUUID().replaceAll('-', ''),
    ]);
    expect((await report(adminId, { accountId: cliId }, true)).totals.amountUsd).toBe(100);
    await owner.query('DELETE FROM devices WHERE user_id=$1', [cliId]);
    expect((await report(adminId, { accountId: cliId }, true)).account?.id).toBe(cliId);
    // Ripristina la classificazione della fixture per le altre verifiche.
    await owner.query('UPDATE usage_accounts SET installation_seen_at=NULL WHERE user_id=$1', [
      cliId,
    ]);
  });

  it('RLS protegge dati e concessioni anche sotto il livello REST', async () => {
    const users = await withUser(pool, otherId, (c) =>
      c.query('SELECT DISTINCT user_id FROM usage_ledger'),
    );
    expect(users.rows).toEqual([{ user_id: otherId }]);
    await expect(
      withUser(pool, otherId, (c) =>
        c.query('INSERT INTO usage_admins(user_id) VALUES($1)', [otherId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withUser(pool, otherId, (c) =>
        c.query('DELETE FROM usage_ledger WHERE user_id=$1', [otherId]),
      ),
    ).rejects.toThrow(/permission denied/);
    const patch = await server.inject({
      method: 'PATCH',
      url: '/v1/me/settings',
      headers: headers(otherId),
      payload: { usageAdmin: true },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('rifiuta richieste non autenticate, query invalide e permessi revocati', async () => {
    expect((await server.inject({ method: 'GET', url: '/v1/usage' })).statusCode).toBe(401);
    const invalid = await server.inject({
      method: 'GET',
      url: '/v1/usage?date=2026-02-30',
      headers: headers(adminId),
    });
    expect(invalid.statusCode).toBe(400);
    await owner.query('DELETE FROM usage_admins WHERE user_id=$1', [adminId]);
    expect(
      (await server.inject({ method: 'GET', url: '/v1/usage/admin', headers: headers(adminId) }))
        .statusCode,
    ).toBe(403);
    await owner.query('INSERT INTO usage_admins(user_id) VALUES($1)', [adminId]);
  });

  it('mantiene i costi dopo la cancellazione della fonte e anonimizza gli account eliminati', async () => {
    await owner.query('DELETE FROM llm_calls WHERE user_id=$1', [otherId]);
    expect((await report(otherId)).totals.amountUsd).toBe(2);
    await owner.query('DELETE FROM users WHERE id=$1', [otherId]);
    const data = await report(adminId, { accountId: otherId }, true);
    expect(data.totals.amountUsd).toBe(2);
    expect(data.account).toMatchObject({ deleted: true, name: 'Account eliminato' });
    expect(JSON.stringify(data)).not.toContain('Altro proprietario');
  });

  it('il limite giornaliero include i costi rimossi dallo storico operativo', async () => {
    const id = await call(emptyId, new Date().toISOString(), 0.2, true);
    await owner.query('DELETE FROM llm_calls WHERE id=$1', [id]);
    await expect(createBudgetGuard(pool).assertWithinBudget(emptyId, 0.1)).rejects.toThrow(
      'budget giornaliero',
    );
  });
});
