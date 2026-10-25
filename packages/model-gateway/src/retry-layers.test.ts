import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist')
        out.push(...(await sources(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Oggetto letterale che segue `modelSettings:`, con le graffe annidate. */
function settingsAt(text: string, from: number): string {
  const start = text.indexOf('{', from);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

describe('un solo livello di tentativi verso i modelli', () => {
  it('ogni chiamata Mastra/AI SDK dei pacchetti lascia i tentativi a retryModelCall del gateway', async () => {
    const missing: string[] = [];
    let seen = 0;
    for (const pkg of await readdir(root)) {
      for (const file of await sources(join(root, pkg, 'src')).catch(() => [])) {
        const text = await readFile(file, 'utf8');
        for (const m of text.matchAll(/modelSettings:\s*\{/g)) {
          seen++;
          if (!/\bmaxRetries:\s*0\b/.test(settingsAt(text, m.index)))
            missing.push(`${file.slice(root.length + 1)}:${m.index}`);
        }
      }
    }
    // Con 3 tentativi del gateway dentro i 2 di default dell'SDK, un 429 diventava fino a 9 chiamate.
    expect(seen).toBeGreaterThan(8);
    expect(missing).toEqual([]);
  });
});
