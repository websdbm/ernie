import { z } from 'zod';
import { defineTool, ToolError, type ToolSpec } from '../types.js';

const instant = z.iso.datetime({ offset: true });
const interval = z.object({ startAt: instant, endAt: instant }).strict();
export const TimeWindowsInput = z
  .object({
    window: interval,
    busy: z.array(interval.extend({ id: z.string().min(1).max(80) })).max(200),
    durationMinutes: z.number().int().min(1).max(1440),
    bufferMinutes: z.number().int().min(0).max(240).default(0),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();

/** Pure interval arithmetic: no calendar access, inferred travel times, storage, or reminders. */
export function findTimeWindows(raw: z.input<typeof TimeWindowsInput>) {
  const input = TimeWindowsInput.parse(raw);
  const start = Date.parse(input.window.startAt),
    end = Date.parse(input.window.endAt);
  if (end <= start || end - start > 31 * 86_400_000)
    throw new ToolError(
      'La finestra deve avere fine successiva all’inizio e durare al massimo 31 giorni.',
      'invalid_window',
    );
  const pad = input.bufferMinutes * 60_000;
  const ids = new Set<string>();
  const busy = input.busy
    .map((item) => {
      const from = Date.parse(item.startAt),
        to = Date.parse(item.endAt);
      if (to <= from || ids.has(item.id))
        throw new ToolError(
          'Gli intervalli occupati devono avere durata positiva e identificativi distinti.',
          'invalid_interval',
        );
      ids.add(item.id);
      return { id: item.id, from, to };
    })
    .filter((item) => item.to + pad > start && item.from - pad < end)
    .sort((a, b) => a.from - b.from);
  const conflicts: { ids: [string, string]; startAt: string; endAt: string }[] = [];
  let conflictCount = 0;
  for (let a = 0; a < busy.length; a++) {
    const first = busy[a];
    if (!first) continue;
    for (const second of busy.slice(a + 1)) {
      if (second.from >= first.to) break;
      const from = Math.max(start, first.from, second.from),
        to = Math.min(end, first.to, second.to);
      if (to <= from) continue;
      conflictCount++;
      if (conflicts.length < 20)
        conflicts.push({
          ids: [first.id, second.id],
          startAt: new Date(from).toISOString(),
          endAt: new Date(to).toISOString(),
        });
    }
  }
  const gaps: { from: number; to: number }[] = [];
  let cursor = start;
  for (const item of busy) {
    const from = Math.max(start, item.from - pad),
      to = Math.min(end, item.to + pad);
    if (from > cursor) gaps.push({ from: cursor, to: from });
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) gaps.push({ from: cursor, to: end });
  const candidates = gaps.filter((gap) => gap.to - gap.from >= input.durationMinutes * 60_000);
  return {
    slots: candidates.slice(0, input.limit).map((gap) => ({
      startAt: new Date(gap.from).toISOString(),
      endAt: new Date(gap.to).toISOString(),
      availableMinutes: (gap.to - gap.from) / 60_000,
      earliestEndAt: new Date(gap.from + input.durationMinutes * 60_000).toISOString(),
    })),
    totalFreeMinutes: gaps.reduce((sum, gap) => sum + (gap.to - gap.from) / 60_000, 0),
    conflicts,
    conflictCount,
    limited: candidates.length > input.limit || conflictCount > conflicts.length,
    basis:
      'Solo gli intervalli forniti. Non certifica la disponibilità nel calendario e non salva né sposta impegni.',
  };
}

export const timeWindowsTool: ToolSpec = defineTool({
  id: 'time_windows',
  version: '1',
  category: 'utility',
  description:
    'Calcola conflitti e finestre libere per una durata, dagli orari ISO con fuso forniti. Leggi prima gli impegni pertinenti; usa buffer solo dichiarati o concordati. Non legge calendari, non salva e non attiva avvisi.',
  risk: { readsPrivate: false, ingestsUntrusted: false, externalEffect: false, write: false },
  requiredScopes: ['chat'],
  timeoutMs: 1000,
  inputSchema: TimeWindowsInput,
  outputSchema: z.object({
    slots: z.array(interval.extend({ availableMinutes: z.number(), earliestEndAt: instant })),
    totalFreeMinutes: z.number(),
    conflicts: z.array(interval.extend({ ids: z.tuple([z.string(), z.string()]) })),
    conflictCount: z.number().int().min(0),
    limited: z.boolean(),
    basis: z.string(),
  }),
  execute: async (input) => findTimeWindows(input),
});
