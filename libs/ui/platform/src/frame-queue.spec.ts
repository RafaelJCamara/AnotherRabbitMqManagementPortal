import { describe, expect, it, vi } from 'vitest';

import { TransportError } from './engine-transport';
import { FrameQueue } from './frame-queue';

async function take<T>(queue: FrameQueue<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  const iterator = queue[Symbol.asyncIterator]();
  for (let i = 0; i < n; i += 1) {
    const result = await iterator.next();
    if (result.done === true) break;
    out.push(result.value);
  }
  return out;
}

describe('FrameQueue', () => {
  it('hands queued values to the reader in order', async () => {
    const queue = new FrameQueue<number>(8);
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(await take(queue, 3)).toEqual([1, 2, 3]);
  });

  it('wakes a reader that is already waiting', async () => {
    const queue = new FrameQueue<string>(8);
    const reading = take(queue, 2);
    queue.push('a');
    queue.push('b');
    expect(await reading).toEqual(['a', 'b']);
  });

  it('fails with an overflow error instead of growing past its capacity', async () => {
    const queue = new FrameQueue<number>(2);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false);
    expect(queue.done).toBe(true);
    // The reader still gets what fits, then the failure.
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    await expect(iterator.next()).rejects.toMatchObject({
      reason: 'overflow',
    });
  });

  it('ends cleanly after the queued values, and the failure is reported once', async () => {
    const queue = new FrameQueue<number>(4);
    queue.push(1);
    queue.end();
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });

    const failing = new FrameQueue<number>(4);
    failing.end(new TransportError('protocol', 'bad'));
    const again = failing[Symbol.asyncIterator]();
    await expect(again.next()).rejects.toBeInstanceOf(TransportError);
    expect(await again.next()).toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after the end', () => {
    const queue = new FrameQueue<number>(4);
    queue.end();
    expect(queue.push(1)).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('ends a waiting reader when it is ended', async () => {
    const queue = new FrameQueue<number>(4);
    const reading = take(queue, 1);
    queue.end();
    expect(await reading).toEqual([]);
  });

  it('runs the return hook and drops what is queued when the reader leaves early', async () => {
    const onReturn = vi.fn();
    const queue = new FrameQueue<number>(4, onReturn);
    queue.push(1);
    for await (const value of queue) {
      expect(value).toBe(1);
      break;
    }
    expect(onReturn).toHaveBeenCalledOnce();
    expect(queue.done).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new FrameQueue<number>(0)).toThrow(RangeError);
    expect(() => new FrameQueue<number>(1.5)).toThrow(RangeError);
  });
});
