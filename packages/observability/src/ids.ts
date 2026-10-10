import { randomUUID } from 'node:crypto';

/** Identificativo univoco per richieste HTTP, eventi e correlazioni. */
export function newId(): string {
  return randomUUID();
}
