import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, type Pool, withUser } from '@ernie/db';
import type { SshServer, SshSnapshot } from '@ernie/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createSshService, type SshDeletePrecondition } from './service.js';
import type { SshProviderAdapter, SshTransport } from './types.js';

const OWNER = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const PASSWORD = process.env.APP_DB_PASSWORD;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing synthetic fixture');
  return value;
};

describe.skipIf(!OWNER || !PASSWORD)('SSH deletion compares frozen inventory atomically', () => {
  let owner: Pool, app: Pool;
  const users: string[] = [];
  beforeAll(() => {
    owner = createPool({ connectionString: OWNER as string, max: 4 });
    const url = new URL(OWNER as string);
    url.username = 'ernie_app';
    url.password = PASSWORD as string;
    app = createPool({ connectionString: url.toString(), max: 6 });
  });
  afterAll(async () => {
    await owner?.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await app?.end();
    await owner?.end();
  });
  const frozen = (
    snapshot: SshSnapshot,
    server: SshServer,
  ): z.infer<typeof SshDeletePrecondition> => ({
    server: { id: server.id, revision: server.revision },
    sites: snapshot.sites.filter((site) => site.serverId === server.id),
  });
  async function setup() {
    const a = randomUUID(),
      b = randomUUID();
    users.push(a, b);
    await owner.query(
      "INSERT INTO users(id,display_name) VALUES($1,'SSH delete synthetic A'),($2,'SSH delete synthetic B')",
      [a, b],
    );
    let active = true;
    const unexpected = vi.fn(async (): Promise<never> => {
      throw new Error('Unexpected remote adapter call');
    });
    const transport: SshTransport = { generateKey: unexpected, probe: unexpected, run: unexpected };
    const provider: SshProviderAdapter = { list: unexpected, reboot: unexpected };
    const service = createSshService({
      pool: app,
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      canUse: async () => active,
      transport,
      providers: { vultr: provider, contabo: provider },
    });
    let snapshot = await service.serverSave(a, { name: 'Synthetic server', host: '192.0.2.40' });
    const server = required(snapshot.servers[0]);
    snapshot = await service.siteSave(a, {
      serverId: server.id,
      name: 'Synthetic site',
      url: 'https://example.test',
      path: '/srv/example',
      container: 'wordpress',
    });
    const site = required(snapshot.sites[0]);
    const expected = frozen(snapshot, server);
    const assertNoRemote = () => expect(unexpected).not.toHaveBeenCalled();
    const unchangedAfter = async (action: () => Promise<unknown>) => {
      const before = await service.snapshot(a);
      const audits = await owner.query(
        'SELECT id FROM ssh_audit_events WHERE user_id=$1 ORDER BY id',
        [a],
      );
      await expect(action()).rejects.toMatchObject({ code: 'inventory_changed', statusCode: 409 });
      expect(await service.snapshot(a)).toEqual(before);
      expect(
        (await owner.query('SELECT id FROM ssh_audit_events WHERE user_id=$1 ORDER BY id', [a]))
          .rows,
      ).toEqual(audits.rows);
      assertNoRemote();
    };
    return {
      a,
      b,
      service,
      server,
      site,
      snapshot,
      expected,
      unchangedAfter,
      assertNoRemote,
      disable: () => {
        active = false;
      },
    };
  }
  it('removes only the confirmed server and its references, also with the skill disabled', async () => {
    const c = await setup();
    let snapshot = await c.service.siteSave(c.a, {
      serverId: c.server.id,
      name: 'Second site',
      url: 'https://second.example.test',
    });
    const expected = frozen(snapshot, c.server);
    expected.sites.reverse();
    snapshot = await c.service.serverSave(c.a, { name: 'Unrelated server', host: '192.0.2.41' });
    const unrelated = required(snapshot.servers.find((server) => server.id !== c.server.id));
    await c.service.serverSave(c.b, { name: 'Other account', host: '192.0.2.42' });
    c.disable();
    const result = await c.service.serverDelete(c.a, c.server.id, expected);
    expect(result.servers.map((server) => server.id)).toEqual([unrelated.id]);
    expect(result.sites).toEqual([]);
    expect(
      (await withUser(app, c.b, (client) => client.query('SELECT id FROM ssh_servers'))).rowCount,
    ).toBe(1);
    c.assertNoRemote();
  });
  it('removes a confirmed site while preserving its server and siblings', async () => {
    const c = await setup();
    const snapshot = await c.service.siteSave(c.a, {
      serverId: c.server.id,
      name: 'Sibling',
      url: 'https://sibling.example.test',
    });
    const result = await c.service.siteDelete(c.a, c.site.id, frozen(snapshot, c.server));
    expect(result.servers).toEqual(snapshot.servers);
    expect(result.sites).toEqual(snapshot.sites.filter((site) => site.id !== c.site.id));
    c.assertNoRemote();
  });
  it('retains legacy DELETE compatibility without allowing another account to delete the target', async () => {
    const c = await setup();
    await expect(c.service.serverDelete(c.b, c.server.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(c.service.serverDelete(c.b, c.server.id, c.expected)).rejects.toMatchObject({
      code: 'inventory_changed',
    });
    await expect(c.service.siteDelete(c.b, c.site.id, c.expected)).rejects.toMatchObject({
      code: 'inventory_changed',
    });
    expect((await c.service.siteDelete(c.a, c.site.id)).servers).toHaveLength(1);
    expect((await c.service.serverDelete(c.a, c.server.id)).servers).toHaveLength(0);
    c.assertNoRemote();
  });
  it('rejects a server revision changed after confirmation without deleting or adding audit events', async () => {
    const c = await setup();
    await c.service.serverSave(c.a, {
      id: c.server.id,
      name: 'Changed on another device',
      host: c.server.host,
    });
    await c.unchangedAfter(() => c.service.serverDelete(c.a, c.server.id, c.expected));
    await c.unchangedAfter(() => c.service.siteDelete(c.a, c.site.id, c.expected));
  });
  it.each([
    { name: 'Renamed on another device' },
    { url: 'https://changed.example.test' },
    { path: '/srv/changed' },
    { container: 'changed-container' },
  ])('rejects site metadata changed after confirmation: %j', async (change) => {
    const c = await setup();
    await c.service.siteSave(c.a, { ...c.site, ...change });
    await c.unchangedAfter(() => c.service.serverDelete(c.a, c.server.id, c.expected));
    await c.unchangedAfter(() => c.service.siteDelete(c.a, c.site.id, c.expected));
  });
  it('rejects added or removed linked sites and then permits a fresh confirmation', async () => {
    const c = await setup();
    let snapshot = await c.service.siteSave(c.a, {
      serverId: c.server.id,
      name: 'Added on another device',
      url: 'https://added.example.test',
    });
    await c.unchangedAfter(() => c.service.serverDelete(c.a, c.server.id, c.expected));
    await c.unchangedAfter(() => c.service.siteDelete(c.a, c.site.id, c.expected));
    const withAddition = frozen(snapshot, c.server);
    const added = required(snapshot.sites.find((site) => site.id !== c.site.id));
    snapshot = await c.service.siteDelete(c.a, added.id, withAddition);
    await c.unchangedAfter(() => c.service.serverDelete(c.a, c.server.id, withAddition));
    const result = await c.service.serverDelete(c.a, c.server.id, frozen(snapshot, c.server));
    expect(result.servers).toEqual([]);
    c.assertNoRemote();
  });
  it('rejects a moved site or a target omitted from the frozen sites', async () => {
    const c = await setup();
    await c.unchangedAfter(() =>
      c.service.siteDelete(c.a, c.site.id, { ...c.expected, sites: [] }),
    );
    const snapshot = await c.service.serverSave(c.a, { name: 'Destination', host: '192.0.2.43' });
    const destination = required(snapshot.servers.find((server) => server.id !== c.server.id));
    await c.service.siteSave(c.a, { ...c.site, serverId: destination.id });
    await c.unchangedAfter(() => c.service.siteDelete(c.a, c.site.id, c.expected));
    await c.unchangedAfter(() => c.service.serverDelete(c.a, c.server.id, c.expected));
  });
  it('does not bypass the running-operation guard with a matching precondition', async () => {
    const c = await setup();
    const plan = {
      serverId: c.server.id,
      kind: 'ssh',
      title: 'Synthetic operation',
      reason: 'Isolation test',
      command: 'true',
      verificationCommand: 'true',
      backup: 'Fixture',
      rollback: 'Fixture',
    };
    await owner.query(
      "INSERT INTO ssh_operations(user_id,id,server_id,plan,target_snapshot,generation,status,expires_at,started_at) VALUES($1,$2,$3,$4,$5,1,'running',now()+interval '1 hour',now())",
      [c.a, randomUUID(), c.server.id, plan, { server: c.server }],
    );
    await expect(c.service.serverDelete(c.a, c.server.id, c.expected)).rejects.toMatchObject({
      code: 'operation_running',
    });
    await expect(c.service.siteDelete(c.a, c.site.id, c.expected)).rejects.toMatchObject({
      code: 'operation_running',
    });
    expect((await c.service.snapshot(c.a)).sites).toEqual(c.snapshot.sites);
    c.assertNoRemote();
  });
  it('compares after acquiring the account lock and sees a concurrently committed new site', async () => {
    const c = await setup(),
      writer = await owner.connect();
    await writer.query('BEGIN');
    const pid = required(
      (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0],
    ).pid;
    await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ssh:${c.a}`]);
    await writer.query(
      'INSERT INTO ssh_sites(user_id,id,server_id,name,url) VALUES($1,$2,$3,$4,$5)',
      [c.a, randomUUID(), c.server.id, 'Concurrent site', 'https://concurrent.example.test'],
    );
    const removal = c.service.serverDelete(c.a, c.server.id, c.expected).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      let waiting = false;
      for (let count = 0; count < 100; count++) {
        waiting =
          (
            await owner.query(
              "SELECT 1 FROM pg_locks held JOIN pg_locks waiter ON waiter.locktype=held.locktype AND waiter.classid=held.classid AND waiter.objid=held.objid AND waiter.objsubid=held.objsubid WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted AND NOT waiter.granted",
              [pid],
            )
          ).rowCount === 1;
        if (waiting) break;
        await delay(10);
      }
      expect(waiting).toBe(true);
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    expect(await removal).toMatchObject({ code: 'inventory_changed', statusCode: 409 });
    const snapshot = await c.service.snapshot(c.a);
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.sites).toHaveLength(2);
    c.assertNoRemote();
  });
});
