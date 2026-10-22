import { describe, expect, it, vi } from 'vitest';
import {
  chooseFold,
  ensureExactData,
  exactData,
  fallbackSummary,
  renderSessionSummary,
  type SessionSummary,
  type SessionSummaryStore,
  type SummarySections,
  summarizeSession,
  type ThreadMessage,
} from './session-summary.js';

const base = Date.UTC(2026, 9, 13, 8, 0, 0);
const msg = (i: number, text = `messaggio ${i}`): ThreadMessage => ({
  id: `m${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  createdAt: new Date(base + i * 60_000),
  text,
});

const empty: SummarySections = {
  topics: [],
  done: [],
  open: [],
  preferences: [],
  facts: [],
  state: '',
};

describe('riassunto della conversazione: taglio e dati esatti', () => {
  it('isteresi: sotto la soglia nulla; sopra, si piegano i vecchi e il primo tenuto è dell’utente', () => {
    const msgs = Array.from({ length: 24 }, (_, i) => msg(i));
    expect(chooseFold(msgs, 24, 10)).toBeNull();
    const more = Array.from({ length: 25 }, (_, i) => msg(i));
    const c = chooseFold(more, 24, 10);
    expect(c?.keep[0]?.role).toBe('user');
    expect((c?.keep.length ?? 0) >= 10).toBe(true);
    expect((c?.fold.length ?? 0) + (c?.keep.length ?? 0)).toBe(25);
    expect(c?.fold.at(-1)?.role).toBe('assistant');
  });

  it('i dati esatti dell’utente persi dal modello vengono riaggiunti', () => {
    const lines = [
      msg(
        0,
        'Ricordami la verifica del 17 ottobre alle 9:30, sono 3 pagine, scrivi a prof@scuola.it',
      ),
      msg(1, 'Va bene, 17 ottobre alle 9:30.'),
    ];
    const data = exactData(lines);
    expect(data).toEqual(
      expect.arrayContaining(['9:30', '17 ottobre', '3 pagine', 'prof@scuola.it']),
    );
    const fixed = ensureExactData({ ...empty, facts: ['Verifica il 17 ottobre alle 9:30'] }, data);
    expect(fixed.facts.at(-1)).toBe('Citati anche: 3 pagine, prof@scuola.it');
    // Niente da aggiungere: resta identico.
    const same = { ...empty, facts: ['17 ottobre, 9:30, 3 pagine, prof@scuola.it'] };
    expect(ensureExactData(same, data)).toBe(same);
  });

  it('ripiego senza modello e testo per il prompt', () => {
    const f = fallbackSummary({ ...empty, done: ['Il 12/10 ha aggiunto il latte'] }, [
      msg(0, 'ciao'),
      msg(2, 'compriamo il pane'),
    ]);
    expect(f.done).toEqual(['Il 12/10 ha aggiunto il latte']);
    expect(f.topics).toEqual(['ciao', 'compriamo il pane']);
    const text = renderSessionSummary({
      sections: { ...f, facts: ['latte 2 l'], state: 'Spesa quasi pronta.' },
      coveredUntil: new Date(),
      messages: 14,
      version: 1,
      fallback: true,
    });
    expect(text).toContain('## Riassunto della conversazione precedente (14 messaggi)');
    expect(text).toContain('non rifarle');
    expect(text).toContain('### Fatto o deciso\n- Il 12/10 ha aggiunto il latte');
    expect(text).toContain('### Situazione\nSpesa quasi pronta.');
    expect(text).not.toContain('### In sospeso'); // sezioni vuote omesse
  });
});

describe('summarizeSession', () => {
  function fakes(n: number, prev: SessionSummary | null = null) {
    const saved: Array<Omit<SessionSummary, 'version'>> = [];
    const store: SessionSummaryStore = {
      get: async () => prev,
      save: async (_u, _s, s) => {
        saved.push(s);
        return saved.length;
      },
    };
    const raw = Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      createdAt: new Date(base + i * 60_000),
      content: {
        format: 2,
        parts: [
          { type: 'text', text: `messaggio ${i}${i === 2 ? ' alle 18:45' : ''}` },
          ...(i % 2
            ? [{ type: 'tool-invocation', toolInvocation: { result: 'SEGRETO DEL TOOL' } }]
            : []),
        ],
      },
    }));
    return {
      saved,
      store,
      threads: { recall: async () => ({ messages: raw }) },
    };
  }
  const logger = { info: () => {}, warn: () => {} };

  it('sotto la soglia non chiama il modello; sopra riassume i vecchi senza testo dei tool', async () => {
    const f = fakes(20);
    let calls = 0;
    const r0 = await summarizeSession(
      {
        threads: f.threads,
        store: f.store,
        logger,
        summarizer: async () => {
          calls++;
          return empty;
        },
      },
      { userId: 'u', sessionId: 's' },
    );
    expect(r0.compacted).toBe(false);
    expect(calls).toBe(0);

    const g = fakes(30);
    let seen = '';
    const r = await summarizeSession(
      {
        threads: g.threads,
        store: g.store,
        logger,
        summarizer: async ({ fold, previous }) => {
          seen = fold.map((m) => m.text).join(' | ');
          expect(previous).toBeNull();
          return { ...empty, topics: ['test'] };
        },
      },
      { userId: 'u', sessionId: 's' },
    );
    expect(r.compacted).toBe(true);
    expect(r.folded).toBe(20);
    expect(seen).not.toContain('SEGRETO DEL TOOL');
    expect(g.saved[0]?.coveredUntil).toEqual(new Date(base + 19 * 60_000));
    expect(g.saved[0]?.messages).toBe(20);
    expect(g.saved[0]?.sections.facts.at(-1)).toBe('Citati anche: 18:45');
  });

  it('budget bloccato: nessuna chiamata LLM e riassunto deterministico preservato', async () => {
    const f = fakes(30);
    const summarizer = vi.fn(async () => empty);
    const checkBudget = vi.fn(async () => {
      throw new Error('budget esaurito');
    });
    const result = await summarizeSession(
      { threads: f.threads, store: f.store, logger, summarizer, checkBudget },
      { userId: 'u', sessionId: 's' },
    );
    expect(checkBudget).toHaveBeenCalledWith('u');
    expect(summarizer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ compacted: true, fallback: true });
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.fallback).toBe(true);
  });

  it('riprende dal riassunto precedente e ripiega se il modello fallisce', async () => {
    const prev: SessionSummary = {
      sections: { ...empty, done: ['fatto prima'] },
      coveredUntil: new Date(base + 9 * 60_000),
      messages: 10,
      version: 3,
      fallback: false,
    };
    const f = fakes(40, prev);
    const r = await summarizeSession(
      {
        threads: f.threads,
        store: f.store,
        logger,
        summarizer: async () => {
          throw new Error('provider giù');
        },
      },
      { userId: 'u', sessionId: 's' },
    );
    expect(r).toMatchObject({ compacted: true, uncovered: 30, fallback: true });
    expect(f.saved[0]?.messages).toBe(10 + (r.folded ?? 0));
    expect(f.saved[0]?.sections.done).toEqual(['fatto prima']);
  });
});
