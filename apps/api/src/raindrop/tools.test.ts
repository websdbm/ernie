import type { ToolContext } from '@ernie/tools';
import { describe, expect, it } from 'vitest';
import type { RaindropService } from './service.js';
import { createRaindropTools } from './tools.js';

describe('bounded collection resolution for Raindrop agent', () => {
  it('finds nested names beyond the first page and preserves duplicate-name context', async () => {
    const all = Array.from({ length: 35 }, (_, id) => ({
      id: id + 1,
      title: `Raccolta ${id + 1}`,
      parentId: null as number | null,
      count: 1,
    }));
    all.push(
      { id: 90, title: 'WordPress', parentId: 1, count: 3 },
      { id: 91, title: 'WordPress', parentId: 2, count: 4 },
    );
    const service = {
      collections: async (user: string) => {
        expect(user).toBe('account-A');
        return all;
      },
    } as RaindropService;
    const tool = createRaindropTools(service).find((v) => v.id === 'raindrop_collections');
    if (!tool) throw new Error('missing tool');
    const ctx = { userId: 'account-A' } as ToolContext;
    const input = tool.inputSchema.parse({ query: 'WordPress', limit: 1 });
    const first = await tool.execute(input, ctx);
    expect(first).toMatchObject({
      total: 37,
      matches: 2,
      items: [{ id: 90, path: 'Raccolta 1 / WordPress' }],
      nextOffset: 1,
    });
    const second = await tool.execute(
      tool.inputSchema.parse({ query: 'WordPress', offset: 1 }),
      ctx,
    );
    expect(second).toMatchObject({
      items: [{ id: 91, path: 'Raccolta 2 / WordPress' }],
      nextOffset: null,
    });
  });
});
