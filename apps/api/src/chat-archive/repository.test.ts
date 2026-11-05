import { describe, expect, it } from 'vitest';
import { overlapConfidence, reconcileMessages } from './repository.js';

const old = (values: string[]) => values.map((fingerprint, i) => ({ fingerprint, id: `old-${i}` }));
const incoming = (values: string[]) => values.map((fingerprint) => ({ fingerprint }));

describe('ordered archive reconciliation', () => {
  it('keeps all intentional repeats and appends only additional occurrences', () => {
    expect(
      reconcileMessages(old(['a', 'b', 'b', 'c']), incoming(['a', 'b', 'b', 'c', 'c', 'd'])),
    ).toEqual(['old-0', 'old-1', 'old-2', 'old-3', null, null]);
    expect(reconcileMessages(old(['a', 'b', 'b', 'c']), incoming(['b', 'b', 'c']))).toEqual([
      'old-1',
      'old-2',
      'old-3',
    ]);
  });
  it('preserves earlier history omitted by new export and handles backfill/inserted messages', () => {
    expect(reconcileMessages(old(['a', 'b', 'c', 'd']), incoming(['c', 'd', 'e']))).toEqual([
      'old-2',
      'old-3',
      null,
    ]);
    expect(reconcileMessages(old(['b', 'c']), incoming(['a', 'b', 'x', 'c']))).toEqual([
      null,
      'old-0',
      null,
      'old-1',
    ]);
  });
  it('never considers a bare name, one short coincidence or repeated identical text a safe archive match', () => {
    expect(overlapConfidence(old(['a']), incoming(['a']))).toBe(0);
    expect(overlapConfidence(old(['a', 'a', 'a', 'a', 'a']), incoming(['a', 'a', 'a', 'a']))).toBe(
      0,
    );
    expect(overlapConfidence(old(['a', 'b', 'c']), incoming(['a', 'b', 'c']))).toBeLessThan(0.95);
    expect(
      overlapConfidence(old(['a', 'b', 'c', 'd']), incoming(['a', 'b', 'c', 'd', 'e'])),
    ).toBeGreaterThanOrEqual(0.95);
  });
  it('scales to large overlapping sequences without a quadratic LCS matrix', () => {
    const all = Array.from({ length: 20_000 }, (_, i) => `m${i}`);
    const result = reconcileMessages(old(all), incoming([...all, 'new']));
    expect(result.filter(Boolean)).toHaveLength(20_000);
    expect(result.at(-1)).toBeNull();
  });
});
