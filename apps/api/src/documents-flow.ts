import type { DocumentRepository, Summarizer } from '@ernie/documents';
import type { ContentBlock, SchemaType } from '@ernie/protocol';

/**
 * Percorso deterministico dei documenti: con un allegato nel messaggio non si lascia al modello la scelta del
 * documento (è capitato che riusasse quello precedente) né del tipo di schema. Riassunto e schema vengono prodotti
 * qui, con la classe standard del riassuntore, e mostrati come schede; il modello entra solo se l'utente fa una
 * domanda sul testo.
 */
export interface DocumentRequest {
  /** Tipo di schema chiesto esplicitamente («mappa», «flusso», «linea del tempo»); altrimenti sceglie il riassuntore. */
  readonly schemaType?: SchemaType;
  /** Taglio particolare chiesto dall'utente («concentrati sulle date»), passato al riassuntore. */
  readonly focus?: string;
  /** Domanda o richiesta oltre il riassunto: il turno prosegue con il modello e il documento annotato. */
  readonly question: boolean;
}

export const DEFAULT_DOCUMENT_PROMPT = 'Riassumi questo documento per studiarlo e fammi lo schema.';

const SCHEMA_WORDS: readonly (readonly [RegExp, SchemaType])[] = [
  [/\b(schema a frecce|frecce|scaletta|appunti|outline)\b/iu, 'outline'],
  [/\b(mappa|mentale|concettuale|mindmap)\b/iu, 'mindmap'],
  [/\b(flusso|processo|procedura|passaggi|diagramma di flusso|flowchart|flow)\b/iu, 'flow'],
  [/\b(linea del tempo|cronolog\w*|timeline|sequenza temporale|date)\b/iu, 'timeline'],
];

export function schemaTypeIn(text: string): SchemaType | undefined {
  for (const [re, type] of SCHEMA_WORDS) if (re.test(text)) return type;
  return undefined;
}

export const SCHEMA_LABEL: Record<SchemaType, string> = {
  outline: 'frecce',
  mindmap: 'mappa mentale',
  flow: 'flusso',
  timeline: 'linea del tempo',
};

const QUESTION =
  /\?|^(?:spiega\w*|perch[eé]|cosa|che cosa|come|quali?|chi|quando|dove|dimmi|traduci\w*|elenca\w*|trova\w*|cerca\w*|quant[oaie]|confronta\w*|descrivi\w*|rispondi\w*)\b/iu;
const ROUTINE =
  /^(?:riassumi|riassunto|fammi|fai|schema|leggi|studia|sintetizza|schematizza|mappa|flusso|linea del tempo|cronologia|ok|ecco|questo|allegato|documento)/iu;

export function parseDocumentRequest(raw: string): DocumentRequest {
  const text = raw.trim();
  const schemaType = schemaTypeIn(text);
  if (!text || text === DEFAULT_DOCUMENT_PROMPT)
    return { question: false, ...(schemaType ? { schemaType } : {}) };
  const question = QUESTION.test(text);
  const routine = ROUTINE.test(text) || text.length <= 40;
  const focus = !question && !routine ? text.slice(0, 300) : undefined;
  return {
    question,
    ...(schemaType ? { schemaType } : {}),
    ...(focus ? { focus } : {}),
  };
}

/** «schema «Titolo» come flusso», «rifai lo schema di «Titolo» a linea del tempo»: il titolo tra virgolette. */
export function parseSchemaCommand(raw: string): { title: string; type: SchemaType } | null {
  const text = raw.trim();
  if (!/schema/iu.test(text)) return null;
  const m = /[«"“]([^»"”]{1,160})[»"”]/u.exec(text);
  if (!m?.[1]) return null;
  const type = schemaTypeIn(text.replace(m[0], ''));
  if (!type) return null;
  return { title: m[1].trim(), type };
}

export interface DocumentsFlowDeps {
  readonly repo: DocumentRepository;
  readonly summarizer: Summarizer | null;
}

export interface FlowScope {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly requestId: string;
}

export interface FlowReply {
  readonly text: string;
  readonly blocks: readonly ContentBlock[];
}

export function createDocumentsFlow(deps: DocumentsFlowDeps) {
  const summarizer = () => {
    if (!deps.summarizer)
      throw new Error('riassuntore non disponibile (nessun modello configurato)');
    return deps.summarizer;
  };

  return {
    /** Allegato nel messaggio: riassunto (dalla cache se c'è) e schema del tipo chiesto; schede pronte. */
    async attached(
      scope: FlowScope,
      documentId: string,
      req: DocumentRequest,
    ): Promise<FlowReply | null> {
      const doc = await deps.repo.get(scope.userId, documentId);
      if (!doc) return null;
      const input = { id: doc.id, title: doc.title, pageTexts: doc.pageTexts };
      let products = doc.products;
      let title = doc.title;
      const schemas: Partial<Record<SchemaType, ContentBlock & { kind: 'schema' }>> = {};
      if (!products || req.focus) {
        const r = await summarizer().summarize(input, scope, req.focus);
        await deps.repo.saveProducts(scope.userId, doc.id, r.products, r.schema);
        products = r.products;
        title = r.title || doc.title;
        schemas[r.schema.type] = {
          kind: 'schema',
          documentId: doc.id,
          title,
          diagram: r.schema.diagram,
        };
      }
      const type = req.schemaType ?? products.suggestedSchema;
      let schema = schemas[type];
      if (!schema) {
        const cached = doc.schemas[type];
        const diagram = cached ?? (await summarizer().schema(input, products, type, scope));
        if (!cached) await deps.repo.saveSchema(scope.userId, doc.id, type, diagram);
        schema = { kind: 'schema', documentId: doc.id, title, diagram };
      }
      const document: ContentBlock = {
        kind: 'document',
        documentId: doc.id,
        title: title.slice(0, 160),
        pages: doc.pages,
        source: doc.source,
        abstract: products.abstract,
        keyPoints: products.keyPoints,
        ...(products.glossary.length ? { glossary: products.glossary } : {}),
        ...(products.questions.length ? { questions: products.questions } : {}),
      };
      const pages = doc.pages === 1 ? '1 pagina' : `${doc.pages} pagine`;
      const chosen = req.schemaType
        ? ''
        : ' (il tipo l’ho scelto io: puoi chiederne un altro dalla scheda)';
      return {
        text: `📄 Ho letto «${title}» (${pages}): ecco il riassunto e lo schema a ${SCHEMA_LABEL[type]}${chosen}. Se vuoi, fammi domande sul testo.`,
        blocks: [document, { ...schema, title: title.slice(0, 160) }],
      };
    },

    /** «schema «Titolo» come flusso» senza allegato: ritrova il documento dal titolo e disegna quel tipo. */
    async schemaByTitle(
      scope: FlowScope,
      title: string,
      type: SchemaType,
    ): Promise<FlowReply | null> {
      const found = await deps.repo.list(scope.userId, title, 5);
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const meta = found.find((d) => norm(d.title) === norm(title)) ?? found[0];
      if (!meta) return { text: `Non trovo un documento chiamato «${title}».`, blocks: [] };
      const doc = await deps.repo.get(scope.userId, meta.id);
      if (!doc) return null;
      const input = { id: doc.id, title: doc.title, pageTexts: doc.pageTexts };
      let products = doc.products;
      if (!products) {
        const r = await summarizer().summarize(input, scope);
        await deps.repo.saveProducts(scope.userId, doc.id, r.products, r.schema);
        products = r.products;
        if (r.schema.type === type)
          return {
            text: `Ecco lo schema a ${SCHEMA_LABEL[type]} di «${doc.title}».`,
            blocks: [
              {
                kind: 'schema',
                documentId: doc.id,
                title: doc.title.slice(0, 160),
                diagram: r.schema.diagram,
              },
            ],
          };
      }
      const cached = doc.schemas[type];
      const diagram = cached ?? (await summarizer().schema(input, products, type, scope));
      if (!cached) await deps.repo.saveSchema(scope.userId, doc.id, type, diagram);
      return {
        text: `Ecco lo schema a ${SCHEMA_LABEL[type]} di «${doc.title}».`,
        blocks: [{ kind: 'schema', documentId: doc.id, title: doc.title.slice(0, 160), diagram }],
      };
    },
  };
}

export type DocumentsFlow = ReturnType<typeof createDocumentsFlow>;
