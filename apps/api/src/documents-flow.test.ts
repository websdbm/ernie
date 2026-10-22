import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_PROMPT,
  parseDocumentRequest,
  parseSchemaCommand,
} from './documents-flow.js';

describe('richieste sui documenti', () => {
  it('riconosce il tipo di schema chiesto e il testo di default', () => {
    expect(parseDocumentRequest(DEFAULT_DOCUMENT_PROMPT)).toEqual({ question: false, study: true });
    expect(parseDocumentRequest('fammi una linea del tempo')).toEqual({
      question: false,
      study: true,
      schemaType: 'timeline',
    });
    expect(parseDocumentRequest('Riassumi e fai la mappa mentale')).toEqual({
      question: false,
      study: true,
      schemaType: 'mindmap',
    });
    expect(parseDocumentRequest('schema a flusso')).toEqual({
      question: false,
      study: true,
      schemaType: 'flow',
    });
    expect(
      parseDocumentRequest(
        'Riassumi questo documento per studiarlo e fammi lo schema a schema a frecce.',
      ),
    ).toEqual({ question: false, study: true, schemaType: 'outline' });
  });

  it('distingue una domanda (modello) da un taglio particolare (focus)', () => {
    expect(parseDocumentRequest('Spiegami il secondo paragrafo').question).toBe(true);
    expect(parseDocumentRequest('quali sono le cause della guerra?').question).toBe(true);
    const f = parseDocumentRequest(
      'Concentrati sulle date degli eventi e sui protagonisti principali',
    );
    expect(f).toEqual({
      question: false,
      study: false,
      focus: 'Concentrati sulle date degli eventi e sui protagonisti principali',
      schemaType: 'timeline',
    });
  });

  it.each([
    '',
    'Leggi questo allegato.',
    'Acquisisci questa ricetta',
    'Non farmi uno schema, acquisisci la ricetta',
    'Leggi la ricetta senza riassunto',
    'Salva la ricetta',
    'Ecco una foto',
    'Ricetta con passaggi e tempi',
  ])('non trasforma %j in studio', (text) => {
    expect(parseDocumentRequest(text).study).toBe(false);
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
