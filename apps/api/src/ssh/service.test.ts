import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SshDeletePrecondition, SshDeleteRequest } from './service.js';

describe('SSH deletion inventory precondition schema', () => {
  const server = { id: randomUUID(), revision: 3 };
  const site = {
    id: randomUUID(),
    serverId: server.id,
    name: 'Synthetic site',
    url: 'https://example.test',
    path: '',
    container: '',
  };
  it('allows the old empty request or a full strictly typed inventory', () => {
    expect(SshDeleteRequest.parse({})).toEqual({});
    expect(SshDeleteRequest.parse({ expected: { server, sites: [site] } })).toEqual({
      expected: { server, sites: [site] },
    });
    expect(
      SshDeletePrecondition.parse({
        server: { ...server, id: server.id.toUpperCase() },
        sites: [{ ...site, serverId: site.serverId.toUpperCase() }],
      }),
    ).toEqual({ server, sites: [site] });
  });
  it('rejects missing fields, unrelated/duplicate sites, extra authority fields and invalid revisions', () => {
    for (const expected of [
      { server, sites: [{ ...site, path: undefined }] },
      { server, sites: [{ ...site, container: undefined }] },
      { server, sites: [{ ...site, serverId: randomUUID() }] },
      { server, sites: [site, site] },
      { server: { ...server, revision: 0 }, sites: [] },
      { server: { ...server, revision: 1.5 }, sites: [] },
      { server: { ...server, userId: randomUUID() }, sites: [] },
      { server, sites: [{ ...site, command: 'true' }] },
      { server, sites: [], approved: true },
      { server, sites: [{ ...site, id: '../other' }] },
    ])
      expect(SshDeletePrecondition.safeParse(expected).success).toBe(false);
    for (const body of [
      null,
      { expected: null },
      { expected: { server, sites: [site] }, userId: randomUUID() },
    ]) {
      expect(SshDeleteRequest.safeParse(body).success).toBe(false);
    }
  });
});
