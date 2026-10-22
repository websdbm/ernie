import { randomUUID } from 'node:crypto';
import type { SshProviderCredentials, SshProviderInstance } from '@ernie/protocol';
import { z } from 'zod';
import type { SshProviderAdapter } from './ssh/types.js';

const VultrPage = z.object({
  instances: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      hostname: z.string().optional(),
      main_ip: z.string().optional(),
      status: z.string().optional(),
      power_status: z.string().optional(),
      server_status: z.string().optional(),
    }),
  ),
  meta: z
    .object({ links: z.object({ next: z.string().nullable().optional() }).optional() })
    .optional(),
});
const ContaboPage = z.object({
  data: z.array(
    z.object({
      instanceId: z.union([z.number(), z.string()]),
      displayName: z.string().optional(),
      name: z.string().optional(),
      ipConfig: z.object({ v4: z.object({ ip: z.string() }).optional() }).optional(),
      status: z.string().optional(),
    }),
  ),
  _pagination: z.object({ totalPages: z.number().int().min(0) }).optional(),
});

/** Fixed official endpoints only; no redirect, no body/error logging, no mutation retries. */
export function createSshProviderAdapters(
  fetcher: typeof fetch = fetch,
): Record<'vultr' | 'contabo', SshProviderAdapter> {
  async function call(url: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'Accesso API rifiutato. Controlla credenziali e restrizioni IP.'
            : `Il provider ha risposto con errore ${response.status}.`,
        );
      }
      if (response.status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) return {};
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          bytes += r.value.length;
          if (bytes > 2_000_000) {
            await reader.cancel();
            throw new Error('Risposta del provider troppo grande.');
          }
          chunks.push(r.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      if (
        error instanceof Error &&
        /^(Accesso API|Il provider|Risposta del provider)/.test(error.message)
      )
        throw error;
      throw new Error(
        'Il provider non ha confermato l’esito. Verifica lo stato prima di ripetere l’operazione.',
      );
    }
  }
  const vultrHeaders = (credentials: SshProviderCredentials) => {
    if (credentials.provider !== 'vultr') throw new Error('Credenziali provider non compatibili.');
    return { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' };
  };
  async function contaboHeaders(credentials: SshProviderCredentials) {
    if (credentials.provider !== 'contabo')
      throw new Error('Credenziali provider non compatibili.');
    const token = z.object({ access_token: z.string().min(1) }).parse(
      await call('https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          username: credentials.username,
          password: credentials.password,
        }).toString(),
      }),
    );
    if (typeof token.access_token !== 'string' || !token.access_token)
      throw new Error('Accesso API rifiutato. Controlla le credenziali Contabo.');
    return {
      Authorization: `Bearer ${token.access_token}`,
      'x-request-id': randomUUID(),
      'Content-Type': 'application/json',
    };
  }
  const clean = (v: unknown) =>
    typeof v === 'string' ? v.slice(0, 300) : typeof v === 'number' ? String(v) : '';
  return {
    vultr: {
      async list(credentials) {
        const headers = vultrHeaders(credentials);
        const result: SshProviderInstance[] = [];
        let cursor = '';
        const seen = new Set<string>();
        for (let page = 0; page < 100; page++) {
          const url = new URL('https://api.vultr.com/v2/instances');
          url.searchParams.set('per_page', '100');
          if (cursor) url.searchParams.set('cursor', cursor);
          const body = VultrPage.parse(await call(url.href, { method: 'GET', headers }));
          if (!Array.isArray(body.instances)) throw new Error('Risposta del provider non valida.');
          for (const i of body.instances)
            result.push({
              id: clean(i.id),
              name: clean(i.label) || clean(i.hostname) || clean(i.id),
              ip: clean(i.main_ip),
              status: [clean(i.status), clean(i.power_status), clean(i.server_status)]
                .filter(Boolean)
                .join(' · '),
            });
          const next = body.meta?.links?.next;
          if (!next) return result;
          const link = new URL(next, 'https://api.vultr.com/v2/instances');
          if (link.origin !== 'https://api.vultr.com' || link.pathname !== '/v2/instances')
            throw new Error('Risposta del provider non valida.');
          cursor = link.searchParams.get('cursor') ?? '';
          if (!cursor || seen.has(cursor))
            throw new Error('Risposta del provider: paginazione non valida.');
          seen.add(cursor);
        }
        throw new Error('Risposta del provider: troppe pagine di istanze.');
      },
      async reboot(credentials, instanceId) {
        if (!/^[a-f0-9-]{36}$/i.test(instanceId))
          throw new Error('Identificativo istanza Vultr non valido.');
        await call(`https://api.vultr.com/v2/instances/${instanceId}/reboot`, {
          method: 'POST',
          headers: vultrHeaders(credentials),
        });
      },
    },
    contabo: {
      async list(credentials) {
        const headers = await contaboHeaders(credentials);
        const result: SshProviderInstance[] = [];
        for (let page = 1; page <= 100; page++) {
          const body = ContaboPage.parse(
            await call(`https://api.contabo.com/v1/compute/instances?page=${page}&size=100`, {
              method: 'GET',
              headers: { ...headers, 'x-request-id': randomUUID() },
            }),
          );
          if (!Array.isArray(body.data)) throw new Error('Risposta del provider non valida.');
          for (const i of body.data)
            result.push({
              id: clean(i.instanceId),
              name: clean(i.displayName) || clean(i.name) || clean(i.instanceId),
              ip: clean(i.ipConfig?.v4?.ip),
              status: clean(i.status),
            });
          const pages = body._pagination?.totalPages;
          if (typeof pages === 'number' ? page >= pages : body.data.length < 100) return result;
        }
        throw new Error('Risposta del provider: troppe pagine di istanze.');
      },
      async reboot(credentials, instanceId) {
        if (!/^\d{1,20}$/.test(instanceId))
          throw new Error('Identificativo istanza Contabo non valido.');
        const headers = await contaboHeaders(credentials);
        await call(`https://api.contabo.com/v1/compute/instances/${instanceId}/actions/restart`, {
          method: 'POST',
          headers,
        });
      },
    },
  };
}
