import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextDeltaBuffer } from './text-deltas.js';

afterEach(() => vi.useRealTimers());

describe('stream text batches', () => {
  it('sends the first text immediately, batches a burst, and flushes after 30 ms', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const buffer = new TextDeltaBuffer(send);
    await buffer.push('Primo');
    expect(send.mock.calls).toEqual([['Primo']]);
    await buffer.push(' secondo');
    await buffer.push(' terzo');
    await vi.advanceTimersByTimeAsync(29);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls).toEqual([['Primo'], [' secondo terzo']]);
    buffer.dispose();
  });

  it('flushes tails, preserves asynchronous transport order, and cancels obsolete timers', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let release: () => void = () => {};
    const buffer = new TextDeltaBuffer(async (delta) => {
      if (delta === 'a')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      sent.push(delta);
    });
    const first = buffer.push('a');
    await vi.waitFor(() => expect(release.toString()).not.toBe('() => {}'));
    await buffer.push('b');
    const end = buffer.flush();
    expect(sent).toEqual([]);
    release();
    await Promise.all([first, end]);
    expect(sent).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(['a', 'b']);
    buffer.dispose();
  });

  it('caps a burst and reduces 101 deltas to two writes without changing any text', async () => {
    const sent: string[] = [];
    const buffer = new TextDeltaBuffer((delta) => {
      sent.push(delta);
    });
    await buffer.push('a');
    for (let n = 0; n < 100; n++) await buffer.push('b');
    await buffer.flush();
    expect(sent).toHaveLength(2);
    expect(sent.join('')).toBe(`a${'b'.repeat(100)}`);
    await buffer.push('c'.repeat(1024));
    expect(sent.at(-1)).toHaveLength(1024);
    buffer.dispose();
  });

  it('reports a timer transport error at the next boundary without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('transport'));
    const buffer = new TextDeltaBuffer(send);
    await buffer.push('first');
    await buffer.push('tail');
    await vi.advanceTimersByTimeAsync(30);
    await expect(buffer.flush()).rejects.toThrow('transport');
    buffer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
