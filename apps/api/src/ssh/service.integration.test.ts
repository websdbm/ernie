import { randomUUID } from 'node:crypto';
import { createPool, type Pool, withUser } from '@ernie/db';
import type { SshPlanInput, SshServer } from '@ernie/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createSshService } from './service.js';
import type { SshProviderAdapter, SshTransport } from './types.js';

const OWNER = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL,
  PASSWORD = process.env.APP_DB_PASSWORD;
describe.skipIf(!OWNER || !PASSWORD)(
  'SSH PostgreSQL isolation, revocation and one-time execution',
  () => {
    let owner: Pool, app: Pool;
    const users: string[] = [];
    beforeAll(async () => {
      owner = createPool({ connectionString: OWNER as string, max: 3 });
      const url = new URL(OWNER as string);
      url.username = 'ernie_app';
      url.password = PASSWORD as string;
      app = createPool({ connectionString: url.toString(), max: 8 });
    });
    afterAll(async () => {
      await owner?.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await app?.end();
      await owner?.end();
    });
    async function setup() {
      const a = randomUUID(),
        b = randomUUID();
      users.push(a, b);
      await owner.query("INSERT INTO users(id,display_name) VALUES($1,'SSH A'),($2,'SSH B')", [
        a,
        b,
      ]);
      const allowed = new Map<string, boolean>([
        [a, true],
        [b, true],
      ]);
      let generation = 0,
        clock = new Date();
      const transport: SshTransport = {
        generateKey: vi.fn(async () => ({
          privateKey: `SYNTHETIC_PRIVATE_${++generation}`,
          publicKey: `ssh-ed25519 SYNTHETIC_PUBLIC_${generation}`,
          fingerprint: `SHA256:synthetic-key-${generation}`,
        })),
        probe: vi.fn(async () => ({ fingerprint: 'SHA256:synthetic-host' })),
        run: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, truncated: false })),
      };
      const provider: SshProviderAdapter = {
        list: vi.fn(async () => [
          { id: 'instance-a', name: 'Synthetic', ip: '192.0.2.12', status: 'running' },
        ]),
        reboot: vi.fn(async () => {}),
      };
      const service = createSshService({
        pool: app,
        masterKey: Buffer.alloc(32, 7).toString('base64'),
        canUse: async (u) => allowed.get(u) === true,
        transport,
        providers: { vultr: provider, contabo: provider },
        now: () => clock,
      });
      await service.keyGenerate(a, false);
      let snapshot = await service.serverSave(a, { name: 'Test server', host: '192.0.2.12' });
      const server = snapshot.servers[0] as SshServer;
      await service.hostProbe(a, server.id);
      snapshot = await service.hostTrust(a, server.id, 'SHA256:synthetic-host');
      const plan = (extra: Partial<z.input<typeof SshPlanInput>> = {}) =>
        service.plan(a, {
          serverId: server.id,
          kind: 'ssh',
          title: 'Intervento test',
          reason: 'Test isolato senza server reale',
          command: 'echo okay',
          verificationCommand: 'true',
          backup: 'Backup di test dichiarato nel piano',
          rollback: 'Ripristino descritto nel piano',
          ...extra,
        });
      return {
        a,
        b,
        allowed,
        service,
        transport,
        provider,
        server,
        plan,
        snapshot,
        setClock: (date: Date) => {
          clock = date;
        },
      };
    }
    it('does not expose secrets and enforces owner RLS and composite site references', async () => {
      const { a, b, service, server } = await setup();
      const snapshot = await service.snapshot(a);
      expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC_PRIVATE');
      expect((await service.snapshot(b)).servers).toEqual([]);
      await expect(service.hostProbe(b, server.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        service.siteSave(b, {
          serverId: server.id,
          name: 'Wrong owner',
          url: 'https://example.test',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const rows = await withUser(app, b, (c) => c.query('SELECT * FROM ssh_servers'));
      expect(rows.rows).toEqual([]);
      await expect(
        withUser(app, b, (c) =>
          c.query('INSERT INTO ssh_sites(user_id,id,server_id,name,url) VALUES($1,$2,$3,$4,$5)', [
            b,
            randomUUID(),
            server.id,
            'Wrong',
            'https://example.test',
          ]),
        ),
      ).rejects.toThrow();
      const encrypted = (
        await owner.query('SELECT private_secret FROM ssh_keys WHERE user_id=$1', [a])
      ).rows[0]?.private_secret;
      expect(JSON.stringify(encrypted)).not.toContain('SYNTHETIC_PRIVATE');
      expect(encrypted.version).toBe(1);
    });
    it('deduplicates identical pending proposals and claims one execution even with concurrent approvals', async () => {
      const { a, service, transport, plan } = await setup();
      const first = await plan(),
        second = await plan();
      expect(second.id).toBe(first.id);
      const results = await Promise.all([
        service.approve(a, first.id),
        service.approve(a, first.id),
      ]);
      expect(results.some((r) => r.status === 'succeeded')).toBe(true);
      expect(transport.run).toHaveBeenCalledTimes(2); // Exactly main + verification, never a second intervention.
      expect((await service.approve(a, first.id)).status).toBe('succeeded');
      expect(transport.run).toHaveBeenCalledTimes(2);
      await expect(
        withUser(app, a, (c) =>
          c.query("UPDATE ssh_operations SET plan='{}' WHERE user_id=$1 AND id=$2", [a, first.id]),
        ),
      ).rejects.toThrow('immutable');
    });
    it('rejects proposals after key rotation/revocation and never revives them after skill reactivation', async () => {
      const { a, service, transport, plan, allowed } = await setup();
      const first = await plan();
      await service.keyGenerate(a, true);
      expect((await service.approve(a, first.id)).status).toBe('rejected');
      const second = await plan();
      await service.keyRevoke(a);
      expect((await service.approve(a, second.id)).status).toBe('rejected');
      await service.keyGenerate(a, false);
      const third = await plan();
      allowed.set(a, false);
      await service.invalidate(a);
      await expect(service.snapshot(a)).rejects.toMatchObject({ code: 'skill_disabled' });
      allowed.set(a, true);
      expect((await service.approve(a, third.id)).status).toBe('rejected');
      expect(transport.run).not.toHaveBeenCalled();
    });
    it('invalidates changed targets, expires plans, and recovers old running operations as uncertain', async () => {
      const { a, service, transport, plan, server, setClock } = await setup();
      const first = await plan();
      await service.serverSave(a, { id: server.id, host: server.host, name: 'Changed' });
      expect((await service.approve(a, first.id)).status).toBe('rejected');
      const second = await plan();
      setClock(new Date(Date.now() + 31 * 60_000));
      expect((await service.approve(a, second.id)).status).toBe('expired');
      setClock(new Date());
      const third = await plan();
      await owner.query(
        "UPDATE ssh_operations SET status='running',started_at=now() WHERE user_id=$1 AND id=$2",
        [a, third.id],
      );
      setClock(new Date(Date.now() + 31 * 60_000));
      expect((await service.operation(a, third.id)).status).toBe('uncertain');
      expect((await service.approve(a, third.id)).status).toBe('uncertain');
      expect(transport.run).not.toHaveBeenCalled();
    });
    it('marks transport interruption uncertain without retrying or leaking adapter error details', async () => {
      const { a, service, transport, plan } = await setup();
      vi.mocked(transport.run).mockRejectedValueOnce(new Error('password=synthetic-secret'));
      const pending = await plan(),
        result = await service.approve(a, pending.id);
      expect(result.status).toBe('uncertain');
      expect(result.output).not.toContain('synthetic-secret');
      expect((await service.approve(a, pending.id)).status).toBe('uncertain');
      expect(transport.run).toHaveBeenCalledTimes(1);
    });
    it('checks live authorization after waiting and prevents the verification command', async () => {
      const { a, service, transport, plan, allowed } = await setup();
      vi.mocked(transport.run).mockImplementationOnce(async () => {
        allowed.set(a, false);
        return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false };
      });
      const operation = await plan(),
        result = await service.approve(a, operation.id);
      expect(result.status).toBe('uncertain');
      expect(transport.run).toHaveBeenCalledTimes(1);
    });
    it('keeps import stable by owner+source+type+sourceId and preserves manual metadata and trust', async () => {
      const { a, b, service } = await setup();
      const input = {
        source: 'https://HF.EXAMPLE.test/inventory/?ignored=true',
        servers: [{ sourceId: 'srv-1', name: 'Imported', host: '192.0.2.30' }],
        sites: [
          {
            sourceId: 'site-1',
            serverSourceId: 'srv-1',
            name: 'Imported site',
            url: 'https://example.test',
          },
        ],
      };
      expect(await service.importPreview(a, input)).toMatchObject({ serversNew: 1, sitesNew: 1 });
      let first = await service.importApply(a, input);
      const imported = first.servers.find((s) => s.host === '192.0.2.30') as SshServer,
        web = first.sites[0];
      if (!web) throw new Error('site');
      await service.serverSave(a, {
        id: imported.id,
        name: 'Manual server',
        host: imported.host,
        provider: 'vultr',
        providerInstanceId: 'instance-a',
      });
      await service.siteSave(a, { ...web, path: '/var/www/manual', container: 'wp-app' });
      await service.hostProbe(a, imported.id);
      await service.hostTrust(a, imported.id, 'SHA256:synthetic-host');
      first = await service.importApply(a, {
        ...input,
        source: 'https://hf.example.test/inventory',
      });
      expect(first.servers.find((s) => s.id === imported.id)).toMatchObject({
        name: 'Manual server',
        provider: 'vultr',
        providerInstanceId: 'instance-a',
        fingerprint: 'SHA256:synthetic-host',
      });
      expect(first.sites[0]).toMatchObject({
        id: web.id,
        path: '/var/www/manual',
        container: 'wp-app',
      });
      expect(await service.importPreview(a, input)).toMatchObject({
        serversNew: 0,
        sitesNew: 0,
        serversUpdated: 1,
        sitesUpdated: 1,
      });
      expect(await service.importPreview(b, input)).toMatchObject({ serversNew: 1, sitesNew: 1 });
      await expect(
        service.importApply(a, { ...input, servers: [...input.servers, ...input.servers] }),
      ).rejects.toMatchObject({ code: 'duplicate_source_id' });
      await expect(
        service.importApply(b, {
          ...input,
          servers: [],
          sites: [{ ...input.sites[0], serverSourceId: 'srv-1' }] as never,
        }),
      ).rejects.toMatchObject({ code: 'unknown_server_reference' });
    });
    it('validates provider credentials before saving and rechecks fresh instance mapping before reboot', async () => {
      const { a, service, provider, server, plan } = await setup();
      vi.mocked(provider.list).mockRejectedValueOnce(new Error('synthetic secret must not leak'));
      await expect(
        service.providerSave(a, 'vultr', { provider: 'vultr', apiKey: 'synthetic-api-key-111111' }),
      ).rejects.toMatchObject({ code: 'provider_auth_failed' });
      expect((await service.snapshot(a)).providers).toEqual([]);
      await service.providerSave(a, 'vultr', {
        provider: 'vultr',
        apiKey: 'synthetic-api-key-111111',
      });
      await service.serverSave(a, {
        id: server.id,
        name: server.name,
        host: server.host,
        provider: 'vultr',
        providerInstanceId: 'instance-a',
      });
      const pending = await plan({ kind: 'provider_reboot', command: '', verificationCommand: '' });
      vi.mocked(provider.list).mockResolvedValueOnce([]);
      expect((await service.approve(a, pending.id)).status).toBe('failed');
      expect(provider.reboot).not.toHaveBeenCalled();
      const accepted = await plan({
        kind: 'provider_reboot',
        command: '',
        verificationCommand: '',
      });
      const result = await service.approve(a, accepted.id);
      expect(result.status).toBe('succeeded');
      expect(result.output).toContain('verificato separatamente');
      expect(provider.reboot).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await service.snapshot(a))).not.toContain('synthetic-api-key');
      const queued = await plan({ kind: 'provider_reboot', command: '', verificationCommand: '' });
      await service.providerDisconnect(a, 'vultr');
      expect((await service.approve(a, queued.id)).status).toBe('rejected');
    });
    it('uses fixed diagnostics, owner-scoped sites and output redaction', async () => {
      const { a, b, service, transport, server } = await setup();
      await expect(
        service.diagnose(a, { serverId: server.id, check: 'disk', command: 'arbitrary' } as never),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        service.diagnose(b, { serverId: server.id, check: 'disk' }),
      ).rejects.toMatchObject({ code: 'not_found' });
      vi.mocked(transport.run).mockResolvedValueOnce({
        stdout: 'password=synthetic-private SYNTHETIC_PRIVATE_1',
        stderr: '',
        exitCode: 0,
        truncated: false,
      });
      const result = await service.diagnose(a, { serverId: server.id, check: 'disk' });
      expect(result.output).not.toContain('synthetic-private');
      expect(result.output).not.toContain('SYNTHETIC_PRIVATE_1');
      expect(vi.mocked(transport.run).mock.calls[0]?.[2]).toBe('df -hP; df -iP');
    });
  },
);
