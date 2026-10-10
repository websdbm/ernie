import { describe, expect, it } from 'vitest';
import { EventDeduper, SequenceSource, SequenceTracker } from './ordering.js';

describe('EventDeduper', () => {
  it('riconosce i duplicati e rispetta la capacità', () => {
    const d = new EventDeduper(2);
    expect(d.isDuplicate('a')).toBe(false);
    expect(d.isDuplicate('a')).toBe(true);
    expect(d.isDuplicate('b')).toBe(false);
    expect(d.isDuplicate('c')).toBe(false); // espelle 'a'
    expect(d.size).toBe(2);
    expect(d.isDuplicate('a')).toBe(false);
  });
});

describe('SequenceTracker', () => {
  it('accetta sequenze consecutive', () => {
    const t = new SequenceTracker();
    expect(t.check(0)).toEqual({ kind: 'ok' });
    expect(t.check(1)).toEqual({ kind: 'ok' });
    expect(t.expected).toBe(2);
  });

  it('segnala duplicati e buchi', () => {
    const t = new SequenceTracker();
    t.check(0);
    expect(t.check(0)).toEqual({ kind: 'duplicate', seq: 0 });
    expect(t.check(3)).toEqual({ kind: 'gap', expected: 1, received: 3 });
    expect(t.check(4)).toEqual({ kind: 'ok' });
  });
});

describe('SequenceSource', () => {
  it('genera numeri monotoni', () => {
    const s = new SequenceSource(5);
    expect(s.next()).toBe(5);
    expect(s.next()).toBe(6);
    expect(s.peek()).toBe(7);
  });
});
