import { z } from 'zod';
import { defineTool, type ToolSpec } from '../types.js';

export const getTimeTool: ToolSpec = defineTool({
  id: 'get_time',
  version: '1',
  category: 'utility',
  description:
    'Restituisce data e ora correnti (ISO 8601) nel fuso orario indicato, predefinito Europe/Rome.',
  risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: false },
  timeoutMs: 1_000,
  inputSchema: z.object({ timezone: z.string().max(64).optional() }),
  outputSchema: z.object({ iso: z.string(), local: z.string(), timezone: z.string() }),
  execute: async ({ timezone }) => {
    const tz = timezone ?? 'Europe/Rome';
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat('it-IT', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: tz,
      }).format(now);
    } catch {
      local = new Intl.DateTimeFormat('it-IT', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Europe/Rome',
      }).format(now);
    }
    return { iso: now.toISOString(), local, timezone: tz };
  },
});
