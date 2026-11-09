import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findTimeWindows, timeWindowsTool } from './time-windows.js';

const at = (hour: string) => `2026-11-09T${hour}:00+01:00`;
const window = { startAt: at('08:00'), endAt: at('20:00') };

describe('time_windows', () => {
  it('finds actual free windows without changing supplied appointments', () => {
    const busy = [
      { id: 'visit', startAt: at('11:00'), endAt: at('12:00') },
      { id: 'cloe-out', startAt: at('15:00'), endAt: at('15:30') },
      { id: 'cloe-back', startAt: at('18:00'), endAt: at('18:30') },
    ];
    const snapshot = JSON.stringify(busy);
    const result = findTimeWindows({ window, busy, durationMinutes: 60, bufferMinutes: 15 });
    expect(result.slots.map((s) => [s.startAt.slice(11, 16), s.endAt.slice(11, 16)])).toEqual([
      ['07:00', '09:45'],
      ['11:15', '13:45'],
      ['14:45', '16:45'],
      ['17:45', '19:00'],
    ]);
    expect(result.totalFreeMinutes).toBe(510);
    expect(result.conflicts).toEqual([]);
    expect(JSON.stringify(busy)).toBe(snapshot);
    expect(result.basis).toContain('Solo gli intervalli forniti');
  });

  it('merges occupied windows but reports each actual overlap, not touching boundaries', () => {
    const result = findTimeWindows({
      window,
      durationMinutes: 30,
      busy: [
        { id: 'a', startAt: at('10:00'), endAt: at('12:00') },
        { id: 'b', startAt: at('11:00'), endAt: at('13:00') },
        { id: 'c', startAt: at('13:00'), endAt: at('14:00') },
      ],
    });
    expect(result.conflicts).toEqual([
      {
        ids: ['a', 'b'],
        startAt: at('11:00').replace('11:00:00+01:00', '10:00:00.000Z'),
        endAt: '2026-11-09T11:00:00.000Z',
      },
    ]);
    expect(result.totalFreeMinutes).toBe(480);
    expect(result.slots).toHaveLength(2);
  });

  it('includes the buffer of an appointment ending at the window start', () => {
    const result = findTimeWindows({
      window,
      durationMinutes: 40,
      bufferMinutes: 20,
      busy: [{ id: 'before', startAt: at('07:00'), endAt: at('08:00') }],
    });
    expect(result.slots[0]?.startAt).toBe('2026-11-09T07:20:00.000Z');
    expect(result.conflictCount).toBe(0);
  });

  it('uses elapsed instants through the daylight saving transition', () => {
    const result = findTimeWindows({
      window: { startAt: '2026-10-25T01:00:00+02:00', endAt: '2026-10-25T04:00:00+01:00' },
      busy: [],
      durationMinutes: 240,
    });
    expect(result.totalFreeMinutes).toBe(240);
    expect(result.slots[0]?.earliestEndAt).toBe('2026-10-25T03:00:00.000Z');
  });

  it('does not invent a slot when everything is occupied and declares truncated results', () => {
    expect(
      findTimeWindows({ window, busy: [{ id: 'all', ...window }], durationMinutes: 1 }).slots,
    ).toEqual([]);
    const result = findTimeWindows({
      window,
      durationMinutes: 1,
      limit: 1,
      busy: [{ id: 'a', startAt: at('10:00'), endAt: at('11:00') }],
    });
    expect(result.slots).toHaveLength(1);
    expect(result.limited).toBe(true);
  });

  it('rejects missing offsets, impossible intervals, duplicate IDs, and excessive inputs', () => {
    expect(() =>
      findTimeWindows({
        window: { startAt: at('20:00'), endAt: at('08:00') },
        busy: [],
        durationMinutes: 1,
      }),
    ).toThrow();
    expect(() =>
      findTimeWindows({
        window,
        busy: [{ id: 'a', startAt: '2026-11-09T08:00:00', endAt: at('09:00') }],
        durationMinutes: 1,
      }),
    ).toThrow();
    expect(() =>
      findTimeWindows({
        window,
        busy: [
          { id: 'a', ...window },
          { id: 'a', ...window },
        ],
        durationMinutes: 1,
      }),
    ).toThrow();
    expect(() => findTimeWindows({ window, busy: [], durationMinutes: 0 })).toThrow();
    expect(() => z.toJSONSchema(timeWindowsTool.inputSchema)).not.toThrow();
    expect(() => z.toJSONSchema(timeWindowsTool.outputSchema)).not.toThrow();
  });
});
