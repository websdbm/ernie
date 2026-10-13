import { describe, expect, it } from 'vitest';
import { acceptTitle } from './reminder-title.js';

describe('acceptTitle', () => {
  it('una riga, senza virgolette né punto finale, iniziale maiuscola, lunghezza sensata', () => {
    expect(acceptTitle('«prendere Giorgio e portarlo alla visita.»')).toBe(
      'Prendere Giorgio e portarlo alla visita',
    );
    expect(acceptTitle('Chiamare papà\nAltro testo')).toBe('Chiamare papà');
    expect(acceptTitle('ok')).toBeNull();
    expect(acceptTitle('x'.repeat(120))).toBeNull();
    expect(acceptTitle(undefined)).toBeNull();
  });
});
