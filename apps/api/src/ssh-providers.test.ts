import { describe, expect, it, vi } from 'vitest';
import { createSshProviderAdapters } from './ssh-providers.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const vultr = { provider: 'vultr' as const, apiKey: 'synthetic-secret' };
const contabo = {
  provider: 'contabo' as const,
  clientId: 'fixture',
  clientSecret: 'secret-fixture',
  username: 'fixture@example.test',
  password: 'password-fixture',
};
describe('provider transports', () => {
  it('reads all Vultr pages and strips unrelated response fields', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          instances: [{ id: '1', label: 'A', main_ip: '1.2.3.4', default_password: 'hidden' }],
          meta: { links: { next: 'https://api.vultr.com/v2/instances?cursor=next' } },
        }),
      )
      .mockResolvedValueOnce(json({ instances: [{ id: '2', label: 'B' }], meta: { links: {} } }));
    const instances = await createSshProviderAdapters(fetcher).vultr.list(vultr);
    expect(instances).toHaveLength(2);
    expect(JSON.stringify(instances)).not.toContain('hidden');
    expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=next');
  });
  it('rejects pagination to other hosts and never sends credentials there', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ instances: [], meta: { links: { next: 'https://evil.invalid/?cursor=x' } } }),
      );
    await expect(createSshProviderAdapters(fetcher).vultr.list(vultr)).rejects.toThrow(
      'non valida',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('exchanges Contabo credentials then only sends token to inventory', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-token' }))
      .mockResolvedValueOnce(
        json({
          data: [
            {
              instanceId: 123,
              displayName: 'Fixture',
              ipConfig: { v4: { ip: '1.2.3.4' } },
              status: 'running',
            },
          ],
          _pagination: { totalPages: 1 },
        }),
      );
    expect((await createSshProviderAdapters(fetcher).contabo.list(contabo))[0]).toEqual({
      id: '123',
      name: 'Fixture',
      ip: '1.2.3.4',
      status: 'running',
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
    );
    expect(fetcher.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(JSON.stringify(fetcher.mock.calls[1])).not.toContain(contabo.password);
  });
  it('does not retry uncertain reboot or leak errors/credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-secret'));
    await expect(
      createSshProviderAdapters(fetcher).vultr.reboot(
        vultr,
        '7d3765cf-467b-4c6f-94d7-4e60e88047ea',
      ),
    ).rejects.toThrow('non ha confermato');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed instance IDs before a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createSshProviderAdapters(fetcher).contabo.reboot(contabo, '../delete'),
    ).rejects.toThrow('non valido');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
