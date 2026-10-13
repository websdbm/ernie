import { describe, expect, it } from 'vitest';
import {
  type ApplyDeps,
  applyWithJudge,
  type Judge,
  type NewFact,
  normalizeDates,
} from './judge.js';
import type { MemoryRecord } from './types.js';

const turn = new Date('2026-10-13T15:00:00Z');

describe('normalizeDates', () => {
  it('piani dalla data della conversazione, effimeri con scadenza, date incoerenti ignorate', () => {
    expect(
      normalizeDates(
        { validFrom: '2026-10-20', validTo: '2026-10-30', retention: 'durable', kind: 'plan' },
        turn,
      ),
    ).toEqual({ validFrom: turn, validTo: new Date('2026-10-30T00:00:00Z') });
    expect(
      normalizeDates(
        { validFrom: '2026-10-17', validTo: null, retention: 'ephemeral', kind: 'event' },
        turn,
      ),
    ).toEqual({
      validFrom: new Date('2026-10-17T00:00:00Z'),
      validTo: new Date('2026-10-24T00:00:00Z'),
    });
    expect(
      normalizeDates(
        { validFrom: 'ieri', validTo: '2020-01-01', retention: 'durable', kind: 'state' },
        turn,
      ),
    ).toEqual({
      validFrom: turn,
      validTo: null,
    });
  });
});

function fakeRepo(existing: Array<{ id: string; content: string; validFrom: Date; sim: number }>) {
  const calls: string[] = [];
  const rec = (e: (typeof existing)[number]): MemoryRecord => ({
    id: e.id,
    userId: 'u',
    kind: 'semantic',
    category: 'fact',
    content: e.content,
    tags: [],
    provenance: { source: 'assistant', trust: 0.8 },
    confidence: 0.9,
    status: 'active',
    validFrom: e.validFrom,
    validTo: null,
    episodeId: null,
    supersedesId: null,
    seenCount: 1,
    lastSeenAt: e.validFrom,
    createdAt: e.validFrom,
    conflictGroup: null,
  });
  let n = 0;
  const repo: ApplyDeps['repo'] = {
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    nearest: async () => existing.map((e) => ({ record: rec(e), sim: e.sim })),
    remember: async (input) => {
      calls.push(`remember:${input.content}`);
      return {
        record: {
          ...rec({
            id: `new${n++}`,
            content: input.content,
            validFrom: input.validFrom ?? turn,
            sim: 1,
          }),
        },
        deduplicated: false,
        superseded: false,
        embedded: true,
      };
    },
    supersede: async (_u, oldId, newId) => {
      calls.push(`supersede:${oldId}->${newId}`);
      return true;
    },
    markDisputed: async (_u, ids) => {
      calls.push(`disputed:${ids.join(',')}`);
      return ids.length;
    },
    reinforce: async (_u, id) => {
      calls.push(`reinforce:${id}`);
    },
    recordEvent: async (_u, e) => {
      calls.push(`event:${e.event}`);
    },
  };
  return { repo, calls };
}

const fact = (over: Partial<NewFact> = {}): NewFact => ({
  content: 'Non è più vegetariano',
  category: 'fact',
  confidence: 0.9,
  retention: 'durable',
  temporalKind: 'state',
  validFrom: turn,
  validTo: null,
  ...over,
});

const decide =
  (
    relation: 'duplicate' | 'refines' | 'contradicts' | 'compatible',
    confidence = 0.9,
    evidence = 'non è più',
  ): Judge =>
  async () => ({
    decisions: [
      { fact: 0, candidate: 0, reasoning: 'r', relation, evidence, confidence },
      {
        fact: 0,
        candidate: 7,
        reasoning: 'fuori intervallo',
        relation: 'contradicts',
        evidence: 'x',
        confidence: 1,
      },
    ],
  });

describe('applyWithJudge', () => {
  const old = {
    id: 'old',
    content: 'È vegetariano',
    validFrom: new Date('2026-09-01T10:00:00Z'),
    sim: 0.71,
  };

  it('smentita con evidenza: il vecchio si chiude e c’è l’evento; l’indice fuori intervallo è scartato', async () => {
    const f = fakeRepo([old]);
    const s = await applyWithJudge(
      { repo: f.repo, judge: decide('contradicts') },
      'u',
      [fact()],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(s).toEqual({ inserted: 1, deduplicated: 0, superseded: 1, disputed: 0 });
    expect(f.calls).toEqual([
      'remember:Non è più vegetariano',
      'supersede:old->new0',
      'event:superseded',
    ]);
  });

  it('stesso giorno: vince il nuovo; giorno precedente: il nuovo nasce chiuso', async () => {
    const sameDay = fakeRepo([{ ...old, validFrom: new Date('2026-10-13T18:00:00Z') }]);
    await applyWithJudge(
      { repo: sameDay.repo, judge: decide('contradicts') },
      'u',
      [fact({ validFrom: new Date('2026-10-13T00:00:00Z') })],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(sameDay.calls).toContain('supersede:old->new0');
    const older = fakeRepo([{ ...old, validFrom: new Date('2026-10-13T08:00:00Z') }]);
    await applyWithJudge(
      { repo: older.repo, judge: decide('contradicts') },
      'u',
      [fact({ validFrom: new Date('2026-10-01T00:00:00Z') })],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(older.calls).toEqual([
      'remember:Non è più vegetariano',
      'supersede:new0->old',
      'event:closed',
    ]);
  });

  it('prove deboli o fatto dedotto → in dubbio; duplicato → rinforzo senza inserire', async () => {
    const weak = fakeRepo([old]);
    const s = await applyWithJudge(
      { repo: weak.repo, judge: decide('contradicts', 0.9, '') },
      'u',
      [fact()],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(s.disputed).toBe(1);
    expect(weak.calls).toContain('disputed:old,new0');
    const inferred = fakeRepo([old]);
    await applyWithJudge(
      { repo: inferred.repo, judge: decide('contradicts') },
      'u',
      [fact({ confidence: 0.6 })],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(inferred.calls).toContain('disputed:old,new0');
    const dup = fakeRepo([old]);
    const d = await applyWithJudge(
      { repo: dup.repo, judge: decide('duplicate') },
      'u',
      [fact()],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(d).toMatchObject({ inserted: 0, deduplicated: 1 });
    expect(dup.calls).toEqual(['reinforce:old']);
  });

  it('giudice in errore o candidati lontani: si inserisce senza ritirare nulla', async () => {
    const broken = fakeRepo([old]);
    const s = await applyWithJudge(
      {
        repo: broken.repo,
        judge: async () => {
          throw new Error('provider giù');
        },
      },
      'u',
      [fact()],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(s).toEqual({ inserted: 1, deduplicated: 0, superseded: 0, disputed: 0 });
    let called = false;
    const far = fakeRepo([{ ...old, sim: 0.4 }]);
    await applyWithJudge(
      {
        repo: far.repo,
        judge: async () => {
          called = true;
          return { decisions: [] };
        },
      },
      'u',
      [fact()],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(called).toBe(false);
    // Quasi identico (≥ 0,92): rinforzo diretto, niente giudice.
    const near = fakeRepo([{ ...old, sim: 0.95 }]);
    await applyWithJudge(
      { repo: near.repo, judge: null },
      'u',
      [fact()],
      { source: 'assistant', trust: 0.8 },
      '2026-10-13',
    );
    expect(near.calls).toEqual(['reinforce:old']);
  });
});
