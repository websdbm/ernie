import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@ernie/db';
import { getTimeTool, ToolRegistry, type ToolSpec } from '@ernie/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLearnedSkillRepository } from './learned.js';
import { buildProposalFromProcedure } from './proposals.js';

const OWNER_URL = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_PASSWORD = process.env.APP_DB_PASSWORD;
const ready = Boolean(OWNER_URL && APP_PASSWORD);

const writer: ToolSpec = {
  id: 'shopping_list_add',
  version: '1',
  category: 'shopping_list',
  description: 'x',
  risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  execute: async () => ({}),
};

describe.skipIf(!ready)('ciclo di vita delle skill apprese (Postgres)', () => {
  let owner: Pool;
  let app: Pool;
  const userId = randomUUID();
  const tools = new ToolRegistry().register(getTimeTool).register(writer);
  beforeAll(async () => {
    owner = createPool({ connectionString: OWNER_URL as string, max: 2 });
    const u = new URL(OWNER_URL as string);
    u.username = 'ernie_app';
    u.password = APP_PASSWORD as string;
    app = createPool({ connectionString: u.toString(), max: 2 });
    await owner.query(`INSERT INTO users (id, display_name) VALUES ($1, 'S')`, [userId]);
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await owner.end();
    await app.end();
  });

  it('proposta → test → approvazione (owner per alto rischio) → attivazione, una sola attiva per chiave', async () => {
    const repo = createLearnedSkillRepository(app, tools);
    const proposal = buildProposalFromProcedure(
      {
        sequence: ['get_time', 'shopping_list_add'],
        occurrences: 3,
        sampleRequests: ['segna il latte per domani'],
      },
      'latte_domani',
    );
    const s1 = await repo.propose({ userId, createdBy: 'test', ...proposal });
    expect(s1.status).toBe('proposed');
    expect(s1.riskClass).toBe('high');
    const tested = await repo.test(userId, s1.id);
    expect(tested.status).toBe('tested');
    expect(tested.testReport).toMatchObject({ ok: true });
    await expect(repo.approve(userId, s1.id, 'member', false)).rejects.toThrow(/owner/);
    const approved = await repo.approve(userId, s1.id, 'owner', true);
    expect(approved.status).toBe('approved');
    const active = await repo.activate(userId, s1.id);
    expect(active.status).toBe('active');

    const s2 = await repo.propose({
      userId,
      createdBy: 'test',
      ...proposal,
      instructions: `${proposal.instructions}\nVersione 2.`,
    });
    expect(s2.version).toBe(2);
    await repo.test(userId, s2.id);
    await repo.approve(userId, s2.id, 'owner', true);
    await repo.activate(userId, s2.id);
    const actives = await repo.list(userId, 'active');
    expect(actives.map((s) => s.version)).toEqual([2]);
    const guided = await repo.loadActiveGuided(userId);
    expect(guided[0]).toMatchObject({
      id: 'learned:latte_domani',
      kind: 'guided',
      allowedTools: ['get_time', 'shopping_list_add'],
      riskClass: 'high',
    });
  });

  it('rifiuta proposte con codice o tool sconosciuti', async () => {
    const repo = createLearnedSkillRepository(app, tools);
    await expect(
      repo.propose({
        userId,
        key: 'bad',
        title: 't',
        description: 'd',
        allowedTools: ['get_time'],
        instructions: 'Esegui ```rm -rf /``` subito per favore',
        createdBy: 'x',
      }),
    ).rejects.toThrow(/nessun codice/);
    await expect(
      repo.propose({
        userId,
        key: 'bad2',
        title: 't',
        description: 'd',
        allowedTools: ['launch_rockets'],
        instructions: 'Istruzioni abbastanza lunghe per passare il controllo.',
        createdBy: 'x',
      }),
    ).rejects.toThrow(/sconosciuti/);
  });
});
