import { SshOperation, SshServer, SshSnapshot } from '@ernie/protocol';
import { z } from 'zod';

export const SshInventoryInput = z
  .object({
    query: z.string().trim().max(200).default(''),
    serverId: z.uuid().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict();
const Counts = z.object({ servers: z.number().int(), sites: z.number().int() });
export const SshInventoryResult = SshSnapshot.extend({
  servers: z.array(SshServer.extend({ siteCount: z.number().int() })),
  totals: Counts,
  matches: Counts,
  pagination: z.object({
    offset: z.number().int(),
    limit: z.number().int(),
    nextOffset: z.number().int().nullable(),
  }),
  // Recent plans are discoverable without sending commands and long diagnostic output on every lookup.
  operations: z.array(
    SshOperation.pick({
      id: true,
      serverName: true,
      kind: true,
      title: true,
      status: true,
      createdAt: true,
    }),
  ),
  recentOperationsReturned: z.number().int(),
});

export function sshInventoryPage(snapshot: SshSnapshot, input: z.infer<typeof SshInventoryInput>) {
  const query = input.query.toLocaleLowerCase('it-IT');
  const contains = (...values: string[]) =>
    values.some((v) => v.toLocaleLowerCase('it-IT').includes(query));
  const scope = snapshot.servers.filter((s) => !input.serverId || s.id === input.serverId);
  const matchingServers = new Set(scope.filter((s) => contains(s.name, s.host)).map((s) => s.id));
  const scopedIds = new Set(scope.map((s) => s.id));
  const sites = snapshot.sites.filter(
    (s) =>
      scopedIds.has(s.serverId) &&
      (matchingServers.has(s.serverId) || contains(s.name, s.url, s.path)),
  );
  const siteServerIds = new Set(sites.map((s) => s.serverId));
  const servers = scope.filter((s) => matchingServers.has(s.id) || siteServerIds.has(s.id));
  const siteCounts = new Map<string, number>();
  for (const site of snapshot.sites)
    siteCounts.set(site.serverId, (siteCounts.get(site.serverId) ?? 0) + 1);
  const end = input.offset + input.limit;
  return SshInventoryResult.parse({
    ...snapshot,
    totals: { servers: snapshot.servers.length, sites: snapshot.sites.length },
    matches: { servers: servers.length, sites: sites.length },
    servers: servers
      .slice(input.offset, end)
      .map((s) => ({ ...s, siteCount: siteCounts.get(s.id) ?? 0 })),
    sites: sites.slice(input.offset, end),
    pagination: {
      offset: input.offset,
      limit: input.limit,
      nextOffset: end < Math.max(servers.length, sites.length) ? end : null,
    },
    operations: snapshot.operations.slice(0, 5),
    recentOperationsReturned: Math.min(snapshot.operations.length, 5),
  });
}
