import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_LABELS, toolDisplayName } from './tool-labels.js';

describe('etichette delle attività', () => {
  it('copre ogni strumento del catalogo e il fallback iOS storico', () => {
    const dir = new URL('../../tools/src/builtins/', import.meta.url);
    const swift = readFileSync(
      new URL('../../../apps/ios/Ernie/Chat/ChatModels.swift', import.meta.url),
      'utf8',
    );
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const m of source.matchAll(/\bid: '([a-z][a-z0-9_]+)'/g)) {
        const id = m[1] ?? '';
        expect(TOOL_LABELS[id], id).toBeTruthy();
        expect(swift).toContain(`"${id}": "${TOOL_LABELS[id]}"`);
      }
    }
    expect(toolDisplayName('unknown_tool')).toBe('Operazione di Ernie');
    expect(toolDisplayName('brain_merge')).toBe('Unione delle schede');
  });
});
