import { RunContext } from '@ernie/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrainToolStore, createBrainTools } from './brain.js';

const knowledge = {
  version: 1,
  facts: [{ id: 'fact', label: 'Sport', value: 'Nuoto', updatedAt: '2026-10-21T10:00:00Z' }],
  routines: [],
};
const ctx = () => ({
  userId: 'owner',
  sessionId: 'session',
  requestId: 'request',
  scopes: ['chat'],
  run: new RunContext('owner', ['chat'], 0),
  device: { timezone: 'Europe/Rome' },
});
const spec = (store: Partial<BrainToolStore>, id: string) => {
  const tool = createBrainTools(store as BrainToolStore).find((entry) => entry.id === id);
  if (!tool) throw new Error('tool missing');
  return tool;
};
afterEach(() => vi.useRealTimers());

describe('consultazione e aggiornamento delle schede, senza automazioni', () => {
  it('restituisce i dati correnti separati dal testo storico', async () => {
    const tool = spec(
      {
        read: async () => ({
          title: 'Anna',
          path: 'Persone/Anna.md',
          type: 'persona',
          created: '2026-10-01',
          refersFrom: null,
          refersTo: null,
          place: null,
          links: [],
          backlinks: [],
          private: false,
          body: 'Prima praticava tennis.',
          knowledge,
        }),
      },
      'brain_read',
    );
    expect(await tool.execute({ title: 'Anna' }, ctx())).toMatchObject({
      text: 'Prima praticava tennis.',
      knowledge,
    });
  });

  it('lega aggiornamento alla sola identità autenticata e non richiede un canale notifiche', async () => {
    const updateKnowledge = vi.fn(async () => ({
      path: 'Persone/Anna.md',
      title: 'Anna',
      knowledge,
    }));
    const tool = spec({ updateKnowledge }, 'brain_knowledge_update');
    const input = { ref: 'Persone/Anna.md', facts: [{ label: 'Sport', value: 'Nuoto' }] };
    expect(tool.inputSchema.safeParse({ ...input, userId: 'someone-else' }).success).toBe(false);
    expect(await tool.execute(input, ctx())).toMatchObject({
      notificationsCreated: false,
      knowledge,
    });
    expect(updateKnowledge).toHaveBeenCalledWith('owner', input);
    expect(tool.oncePerTurn).toBe(true);
    expect(tool.risk.externalEffect).toBe(false);
  });

  it('calcola domani nel fuso del telefono e non include le schede riservate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T23:30:00Z'));
    const agenda = vi.fn(async () => ({
      date: '2026-10-26',
      timeZone: 'Europe/Rome',
      subjects: [],
      entries: [],
    }));
    const tool = spec({ agenda }, 'brain_agenda');
    await tool.execute({ date: 'tomorrow', ref: 'Persone/Anna.md' }, ctx());
    expect(agenda).toHaveBeenCalledWith('owner', {
      date: '2026-10-26',
      timeZone: 'Europe/Rome',
      ref: 'Persone/Anna.md',
    });
    expect(tool.risk.write).toBe(false);
    expect(tool.risk.ingestsUntrusted).toBe(true);
  });

  it('conserva un errore di omonimia comprensibile al modello', async () => {
    const tool = spec(
      {
        agenda: async () => {
          throw Object.assign(new Error('Due schede si chiamano Anna: scegli il percorso.'), {
            code: 'ambiguous_reference',
          });
        },
      },
      'brain_agenda',
    );
    await expect(tool.execute({ date: '2026-10-21' }, ctx())).rejects.toMatchObject({
      code: 'ambiguous_reference',
      message: 'Due schede si chiamano Anna: scegli il percorso.',
    });
  });
});

describe('grounded confirmation and explicit current-day assessment', () => {
  it('rejects model-invented confirmation before any write and anchors valid quotes to authenticated turn', async () => {
    const updateKnowledge = vi.fn(async () => ({
      path: 'Persone/Anna.md',
      title: 'Anna',
      knowledge,
    }));
    const tool = spec({ updateKnowledge }, 'brain_knowledge_update');
    const fact = {
      label: 'Sport',
      value: 'Nuoto',
      status: 'confirmed',
      evidence: {
        kind: 'user',
        ref: 'fake-reference',
        quote: 'Anna fa nuoto',
      },
    };
    const input = { ref: 'Anna', facts: [fact] };
    await expect(tool.execute(input, ctx())).rejects.toMatchObject({ code: 'invalid_knowledge' });
    await expect(
      tool.execute(input, { ...ctx(), userMessage: 'Come sta Anna?' }),
    ).rejects.toMatchObject({ code: 'invalid_knowledge' });
    expect(updateKnowledge).not.toHaveBeenCalled();
    await tool.execute(input, { ...ctx(), userMessage: 'Ricorda che Anna fa nuoto il venerdì.' });
    expect(updateKnowledge).toHaveBeenCalledWith('owner', {
      ...input,
      facts: [{ ...fact, evidence: { ...fact.evidence, ref: 'chat:session:request' } }],
    });
  });
  it('keeps revisions persisted but only returns them when explicitly requested', async () => {
    const current = {
      ...knowledge,
      facts: [
        {
          ...knowledge.facts[0],
          history: [{ label: 'Sport', value: 'Tennis', updatedAt: '2026-09-01T10:00:00Z' }],
        },
      ],
    };
    const tool = spec(
      {
        read: async () => ({
          title: 'Anna',
          path: 'Persone/Anna.md',
          type: 'persona',
          created: '2026-10-01',
          refersFrom: null,
          refersTo: null,
          place: null,
          links: [],
          backlinks: [],
          private: false,
          body: '',
          knowledge: current,
        }),
      },
      'brain_read',
    );
    const compact = await tool.execute({ title: 'Anna' }, ctx());
    expect(JSON.stringify(compact)).not.toContain('Tennis');
    expect(current.facts[0]?.history).toHaveLength(1);
    const expanded = await tool.execute({ title: 'Anna', includeHistory: true }, ctx());
    expect(expanded).toMatchObject({ knowledge: current });
  });
  it('does not present expired or unverified facts as current certainty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T23:30:00Z'));
    const read = spec(
      {
        read: async () => ({
          title: 'Anna',
          path: 'Persone/Anna.md',
          type: 'persona',
          created: '2026-10-01',
          refersFrom: null,
          refersTo: null,
          place: null,
          links: [],
          backlinks: [],
          private: false,
          body: '',
          knowledge: {
            ...knowledge,
            facts: [
              knowledge.facts[0],
              { ...knowledge.facts[0], id: 'old', validUntil: '2026-10-21', status: 'uncertain' },
            ],
          },
        }),
      },
      'brain_read',
    );
    expect(await read.execute({ title: 'Anna' }, ctx())).toMatchObject({
      factAssessment: {
        date: '2026-10-22',
        facts: [
          { id: 'fact', status: 'unverified', validity: 'unspecified' },
          { id: 'old', status: 'uncertain', validity: 'expired' },
        ],
      },
    });
  });
});
