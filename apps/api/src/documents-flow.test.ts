import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_PROMPT,
  parseDocumentRequest,
  parseSchemaCommand,
} from './documents-flow.js';

describe('richieste sui documenti', () => {
  it('riconosce il tipo di schema chiesto e il testo di default', () => {
    expect(parseDocumentRequest(DEFAULT_DOCUMENT_PROMPT)).toEqual({ question: false });
    expect(parseDocumentRequest('fammi una linea del tempo')).toEqual({
      question: false,
      schemaType: 'timeline',
    });
    expect(parseDocumentRequest('Riassumi e fai la mappa mentale')).toEqual({
      question: false,
      schemaType: 'mindmap',
    });
    expect(parseDocumentRequest('schema a flusso')).toEqual({
      question: false,
      schemaType: 'flow',
    });
    expect(
      parseDocumentRequest(
        'Riassumi questo documento per studiarlo e fammi lo schema a schema a frecce.',
      ),
    ).toEqual({ question: false, schemaType: 'outline' });
  });

  it('distingue una domanda (modello) da un taglio particolare (focus)', () => {
    expect(parseDocumentRequest('Spiegami il secondo paragrafo').question).toBe(true);
    expect(parseDocumentRequest('quali sono le cause della guerra?').question).toBe(true);
    const f = parseDocumentRequest(
      'Concentrati sulle date degli eventi e sui protagonisti principali',
    );
    expect(f).toEqual({
      question: false,
      focus: 'Concentrati sulle date degli eventi e sui protagonisti principali',
      schemaType: 'timeline',
    });
  });

  it('comando «schema «Titolo» come tipo»', () => {
    expect(parseSchemaCommand('schema «TESTO STORIA» come linea del tempo')).toEqual({
      title: 'TESTO STORIA',
      type: 'timeline',
    });
    expect(parseSchemaCommand('rifai lo schema di "La fotosintesi" a flusso')).toEqual({
      title: 'La fotosintesi',
      type: 'flow',
    });
    expect(parseSchemaCommand('riapri il documento «TESTO STORIA»')).toBeNull();
    expect(parseSchemaCommand('schema «X»')).toBeNull();
  });
});
