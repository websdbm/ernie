import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopedWebCache, sanitizeWebContent, selectWebContent } from './web-content.js';

afterEach(() => vi.useRealTimers());

describe('web passage selection', () => {
  it('finds the relevant late section instead of the first 3000 characters, with exact source ranges', () => {
    const text = `${'# Introduzione\n\n'}${'Introduzione generale senza dettagli. '.repeat(180)}\n\n## Durata della batteria\n\nLa batteria dura 27 ore durante la navigazione.\n\n${'Appendice non pertinente. '.repeat(60)}`;
    const result = selectWebContent(text, { query: 'Quanto dura la batteria?', maxChars: 900 });
    expect(text.slice(0, 3000)).not.toContain('27 ore');
    expect(result.content).toContain('27 ore');
    expect(result.content.length).toBeLessThanOrEqual(900);
    expect(result.coverage).toMatchObject({
      selection: 'relevant',
      truncated: true,
      storageTruncated: false,
      nextOffset: 0,
      totalChars: text.length,
    });
    expect(result.coverage.ranges.some((range) => range.start > 3000)).toBe(true);
    expect(result.content).toBe(
      result.coverage.ranges.map((range) => text.slice(range.start, range.end)).join('\n\n[…]\n\n'),
    );
  });

  it('matches accented/case variants and preserves section headings and disjoint source order', () => {
    const text = `## Compatibilità\n\n${'Questa sezione descrive compatibilità e requisiti. '.repeat(25)}\n\n## Altro\n\n${'Note generiche. '.repeat(130)}\n\n## Disponibilità\n\nDisponibilità dal 10 novembre. ${'Dettagli aggiuntivi. '.repeat(20)}`;
    const result = selectWebContent(text, {
      query: 'COMPATIBILITA disponibilità novembre',
      maxChars: 1700,
    });
    expect(result.content).toContain('10 novembre');
    expect(result.content).toContain('compatibilità');
    expect(result.coverage.ranges.length).toBeGreaterThan(1);
    expect(
      result.coverage.ranges.every(
        (range, i, ranges) => !i || range.start >= (ranges[i - 1]?.end ?? 0),
      ),
    ).toBe(true);
  });

  it('offset retrieval reassembles the complete sanitized text without gaps', () => {
    const text = sanitizeWebContent(
      `# Fonte\n\n![x](http://image.test)\n\n${'La pagina contiene molti dettagli. '.repeat(130)}`,
      20000,
    );
    let offset: number | null = 0;
    let rebuilt = '';
    while (offset !== null) {
      const result = selectWebContent(text, { maxChars: 250, offset });
      expect(result.coverage.selection).toBe('offset');
      rebuilt += result.content;
      offset = result.coverage.nextOffset;
    }
    expect(rebuilt).toBe(text);
  });

  it('marks complete, unavailable and storage-limited content accurately', () => {
    expect(selectWebContent('short', { maxChars: 100 }).coverage).toMatchObject({
      selection: 'full',
      truncated: false,
      nextOffset: null,
    });
    expect(
      selectWebContent('a'.repeat(100), { maxChars: 200, totalChars: 1000 }).coverage,
    ).toMatchObject({
      totalChars: 1000,
      availableChars: 100,
      truncated: true,
      storageTruncated: true,
      nextOffset: null,
    });
    expect(selectWebContent('', { maxChars: 100 }).coverage).toMatchObject({
      returnedChars: 0,
      ranges: [],
      nextOffset: null,
    });
    expect(
      selectWebContent('a'.repeat(1000), { query: 'unmatched', maxChars: 100 }).coverage,
    ).toMatchObject({ selection: 'start', nextOffset: 100 });
  });
});

describe('short scoped web cache', () => {
  it('separates account and URL keys and expires without sliding on reads', () => {
    vi.useFakeTimers();
    const cache = new ScopedWebCache<string>(100);
    cache.set('alice', 'url:a', 'first', 5);
    cache.set('alice', 'url:b', 'second', 6);
    expect(cache.get('bob', 'url:a')).toBeUndefined();
    expect(cache.get('alice', 'url:b')).toBe('second');
    vi.advanceTimersByTime(75);
    expect(cache.get('alice', 'url:a')).toBe('first');
    vi.advanceTimersByTime(26);
    expect(cache.get('alice', 'url:a')).toBeUndefined();
  });

  it('bounds global entries, per-account entries and retained characters', () => {
    const cache = new ScopedWebCache<string>(1000, 3, 2, 12);
    cache.set('alice', 'a', 'aaaa', 4);
    cache.set('alice', 'b', 'bbbb', 4);
    cache.set('alice', 'c', 'cccc', 4);
    expect(cache.get('alice', 'a')).toBeUndefined();
    cache.set('bob', 'd', 'dddd', 4);
    cache.set('bob', 'e', 'eeee', 4);
    expect(cache.get('alice', 'b')).toBeUndefined();
    expect(cache.get('bob', 'd')).toBe('dddd');
    cache.set('bob', 'large', 'x'.repeat(13), 13);
    expect(cache.get('bob', 'large')).toBeUndefined();
    const disabled = new ScopedWebCache<string>(0);
    disabled.set('alice', 'a', 'text', 4);
    expect(disabled.get('alice', 'a')).toBeUndefined();
  });
});
