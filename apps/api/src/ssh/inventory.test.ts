import { randomUUID } from 'node:crypto';
import { RunContext } from '@ernie/agent-core';
import { createLogger } from '@ernie/observability';
import { SshSnapshot } from '@ernie/protocol';
import { createGuardedTool, memoryToolCallRecorder } from '@ernie/tools';
import { describe, expect, it, vi } from 'vitest';
import type { SshService } from './service.js';
import { createSshTools } from './tools.js';

const userId = randomUUID();
const servers = Array.from({ length: 4 }, (_, i) => ({
  id: randomUUID(),
  name: `Server ${i}`,
  host: `192.0.2.${i + 1}`,
  port: 22,
  username: 'root',
  provider: null,
  providerInstanceId: null,
  fingerprint: null,
  revision: 1,
  lastCheckedAt: null,
  lastStatus: null,
}));
const snapshot = SshSnapshot.parse({
  configured: true,
  key: null,
  servers,
  providers: [],
  operations: [],
  sites: Array.from({ length: 38 }, (_, i) => ({
    id: randomUUID(),
    serverId: servers[i % 4]?.id,
    name: `Sito ${String(i).padStart(2, '0')}`,
    url: `https://site${i}.example.test`,
    path: `/var/www/${'x'.repeat(180)}/${i}/httpdocs`,
    container: '',
  })),
});

function setup() {
  const service = { snapshot: vi.fn(async () => snapshot) } as unknown as SshService;
  const spec = createSshTools(service)[0];
  if (!spec) throw new Error('inventory tool missing');
  const tool = createGuardedTool(
    spec,
    {
      policyRules: {},
      audit: memoryToolCallRecorder(),
      logger: createLogger({ level: 'silent', name: 'ssh-inventory-test' }),
    },
    {
      current: {
        userId,
        sessionId: randomUUID(),
        requestId: randomUUID(),
        modelClass: 'heavy',
        scopes: ['chat'],
        run: new RunContext(userId, ['chat'], 0),
      },
    },
  );
  return { service, tool };
}

describe('SSH inventory presented to the model', () => {
  it('reports exact totals beyond the generic tool result limit and exposes every page', async () => {
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(8000);
    const { tool, service } = setup();
    const found: string[] = [];
    let offset: number | null = 0;
    do {
      const out = (await tool.execute?.(offset === 0 ? {} : { offset }, {} as never)) as {
        totals: { servers: number; sites: number };
        servers: Array<{ id: string; siteCount: number }>;
        sites: Array<{ id: string }>;
        pagination: { nextOffset: number | null };
      };
      expect(out.totals).toEqual({ servers: 4, sites: 38 });
      expect(out.sites.length).toBeLessThanOrEqual(10);
      if (offset === 0) expect(out.servers.map((s) => s.siteCount)).toEqual([10, 10, 9, 9]);
      found.push(...out.sites.map((s) => s.id));
      offset = out.pagination.nextOffset;
    } while (offset !== null);
    expect(found).toEqual(snapshot.sites.map((s) => s.id));
    expect(service.snapshot).toHaveBeenCalledWith(userId);
  });

  it('finds a site after the first page without confusing filtered counts with account totals', async () => {
    const { tool } = setup();
    const out = await tool.execute?.({ query: 'SITE37.EXAMPLE.TEST' }, {} as never);
    expect(out).toMatchObject({
      totals: { servers: 4, sites: 38 },
      matches: { servers: 1, sites: 1 },
      sites: [snapshot.sites[37]],
      pagination: { nextOffset: null },
    });
    const filtered = await tool.execute?.({ serverId: servers[3]?.id }, {} as never);
    expect(filtered).toMatchObject({
      totals: { servers: 4, sites: 38 },
      matches: { servers: 1, sites: 9 },
    });
    const absent = await tool.execute?.({ query: 'unrelated.example.test' }, {} as never);
    expect(absent).toMatchObject({
      totals: { servers: 4, sites: 38 },
      matches: { servers: 0, sites: 0 },
      servers: [],
      sites: [],
    });
  });
});
