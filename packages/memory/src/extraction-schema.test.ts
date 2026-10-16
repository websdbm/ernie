import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Extraction } from './consolidate.js';

/**
 * I modelli con output strutturato rifiutano schemi con più di 16 parametri «unione» (nullabili o anyOf): il
 * 15 ott 2026 i luoghi nella scheda hanno portato lo schema a 19 e il consolidamento della memoria ha smesso di
 * funzionare per due giorni senza che nessun test se ne accorgesse.
 */
const MAX_UNIONS = 16;

export function unionPaths(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.anyOf) || Array.isArray(o.oneOf) || Array.isArray(o.type))
      out.push(path || '/');
    for (const [k, v] of Object.entries(o)) walk(v, `${path}/${k}`);
  };
  walk(schema, '');
  return out;
}

describe('schema dell’estrazione della memoria', () => {
  it(`resta entro ${MAX_UNIONS} parametri nullabili (limite dell’output strutturato)`, () => {
    const unions = unionPaths(z.toJSONSchema(Extraction));
    expect(unions.length, unions.join('\n')).toBeLessThanOrEqual(MAX_UNIONS);
  });
});
