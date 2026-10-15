import { describe, expect, it } from 'vitest';
import { closeLabel } from './family.js';

describe('etichette quasi uguali', () => {
  it('una lettera di differenza su nomi di almeno 4 lettere', () => {
    expect(closeLabel('papi', 'papo')).toBe(true);
    expect(closeLabel('Giorgo', 'Giorgio')).toBe(true);
    expect(closeLabel('Giorgioo', 'giorgio')).toBe(true);
    expect(closeLabel('Nonna', 'nonno')).toBe(true);
    expect(closeLabel('papà', 'papa')).toBe(true);
    expect(closeLabel('zio', 'zia')).toBe(false);
    expect(closeLabel('Marco', 'Mario')).toBe(true);
    expect(closeLabel('Marco', 'Luca')).toBe(false);
    expect(closeLabel('Giorgio', 'Giorgina')).toBe(false);
  });
});
