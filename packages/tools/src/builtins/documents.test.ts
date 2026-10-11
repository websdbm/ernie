import { RunContext } from '@ernie/agent-core';
import type { DocumentRecord, DocumentRepository, Summarizer } from '@ernie/documents';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types.js';
import { createDocumentTools } from './documents.js';

const documentId = '3d8f1b1e-7c3a-4c7e-9c2b-2a1f0e9d8c7d';
const base: DocumentRecord = {
  id: documentId,
  title: 'Fotosintesi',
  source: 'scan',
  language: 'it',
  pages: 2,
  chars: 60,
  status: 'ready',
  createdAt: new Date('2026-10-11T10:00:00Z'),
  updatedAt: new Date('2026-10-11T10:00:00Z'),
  pageTexts: ['Pagina uno sulla luce.', 'Pagina due sul ciclo di Calvin.'],
  products: null,
  schemas: {},
};

function fakeRepo(doc: DocumentRecord | null) {
  const saved: unknown[] = [];
  const repo: DocumentRepository = {
    create: async () => base,
    get: async (_u, id) => (doc && id === doc.id ? doc : null),
    describe: async () => (doc ? doc : null),
    list: async (_u, query) => (query === 'nulla' ? [] : [base]),
    saveProducts: async (_u, _id, products, schema) => {
      saved.push({ products, schema });
    },
    saveSchema: async (_u, _id, type, diagram) => {
      saved.push({ type, diagram });
    },
    remove: async () => true,
  };
  return { repo, saved };
}

const fakeSummarizer: Summarizer = {
  summarize: async (doc, _scope, focus) => ({
    title: focus ? `${doc.title} (${focus})` : doc.title,
    products: {
      abstract: 'Le piante producono zuccheri con la luce.',
      keyPoints: ['Cloroplasti', 'Clorofilla'],
      glossary: [{ term: 'clorofilla', definition: 'pigmento verde' }],
      questions: [{ question: 'Dove?', answer: 'Nei cloroplasti.' }],
      suggestedSchema: 'mindmap',
    },
    schema: { type: 'mindmap', diagram: { type: 'mindmap', root: { label: doc.title } } },
  }),
  schema: async (_doc, _products, type) =>
    type === 'flow'
      ? {
          type: 'flow',
          steps: [
            { id: 'a', label: 'Luce' },
            { id: 'b', label: 'Zuccheri' },
          ],
          links: [{ from: 'a', to: 'b' }],
        }
      : {
          type: 'timeline',
          events: [
            { when: '1', label: 'a' },
            { when: '2', label: 'b' },
          ],
        },
};

const must = <T>(x: T | undefined): T => {
  if (!x) throw new Error('tool mancante');
  return x;
};

const ctx = (): ToolContext => ({
  userId: 'u1',
  sessionId: 's1',
  requestId: 'r1',
  scopes: [],
  run: new RunContext('u1', [], 0),
});

describe('tool documenti', () => {
  it('document_summarize produce riassunto e schema, li salva e li presenta come due schede', async () => {
    const { repo, saved } = fakeRepo(base);
    const [summarize] = createDocumentTools({ repo, summarizer: fakeSummarizer });
    const out = (await must(summarize).execute({ documentId }, ctx())) as { cached: boolean };
    expect(out.cached).toBe(false);
    expect(saved.length).toBe(1);
    const blocks = must(summarize).present?.({ documentId }, out);
    expect(Array.isArray(blocks) && blocks.map((b) => b.kind)).toEqual(['document', 'schema']);
    expect(must(summarize).untrustedSource?.({ documentId }, out)).toBe(`document:${documentId}`);
  });

  it('con prodotti e schema già salvati non richiama il modello', async () => {
    const products = {
      abstract: 'x',
      keyPoints: [],
      glossary: [],
      questions: [],
      suggestedSchema: 'mindmap' as const,
    };
    const { repo } = fakeRepo({
      ...base,
      products,
      schemas: { mindmap: { type: 'mindmap', root: { label: 'x' } } },
    });
    const [summarize] = createDocumentTools({ repo, summarizer: null });
    const out = (await must(summarize).execute({ documentId }, ctx())) as { cached: boolean };
    expect(out.cached).toBe(true);
  });

  it('document_schema disegna il tipo richiesto e document_get taglia il testo per pagine', async () => {
    const { repo } = fakeRepo({
      ...base,
      products: {
        abstract: 'x',
        keyPoints: [],
        glossary: [],
        questions: [],
        suggestedSchema: 'mindmap',
      },
    });
    const [, schema, get, list] = createDocumentTools({ repo, summarizer: fakeSummarizer });
    const flow = (await must(schema).execute({ documentId, type: 'flow' }, ctx())) as {
      diagram: { type: string };
    };
    expect(flow.diagram.type).toBe('flow');
    const page2 = (await must(get).execute({ documentId, fromPage: 2 }, ctx())) as { text: string };
    expect(page2.text).toContain('[pagina 2]');
    expect(page2.text).not.toContain('Pagina uno');
    const docs = (await must(list).execute({}, ctx())) as { documents: Array<{ title: string }> };
    expect(docs.documents[0]?.title).toBe('Fotosintesi');
    expect(must(list).present?.({}, docs)).toMatchObject({
      kind: 'documents',
      pendingText: 'riapri il documento «{documento}»',
    });
    expect(must(list).present?.({ query: 'nulla' }, { documents: [] })).toBeNull();
  });

  it('documento inesistente → errore not_found; senza LLM → llm_unavailable', async () => {
    const { repo } = fakeRepo(null);
    const [summarize] = createDocumentTools({ repo, summarizer: null });
    await expect(must(summarize).execute({ documentId }, ctx())).rejects.toMatchObject({
      code: 'not_found',
    });
    const { repo: repo2 } = fakeRepo(base);
    const [summarize2] = createDocumentTools({ repo: repo2, summarizer: null });
    await expect(must(summarize2).execute({ documentId }, ctx())).rejects.toMatchObject({
      code: 'llm_unavailable',
    });
  });
});
