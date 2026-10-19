import { createManualClock, createManualTimers } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createTokenBucket } from './token-bucket.ts';

function setup(options: {
  perSec: number;
  burst?: number;
  maxWaiters?: number;
}) {
  const clock = createManualClock();
  const timers = createManualTimers(clock);
  const bucket = createTokenBucket({ ...options, clock, timers });
  return { clock, timers, bucket };
}

/** Records the order in which `take` calls resolve. */
function taker(bucket: ReturnType<typeof setup>['bucket']) {
  const order: string[] = [];
  const take = (label: string, n = 1, signal?: AbortSignal) =>
    bucket.take(n, signal).then(
      () => {
        order.push(label);
      },
      () => {
        order.push(`${label}!`);
      },
    );
  return { order, take };
}

describe('token bucket', () => {
  it('starts full: a burst goes through at once, the next call waits for a refill', async () => {
    const { bucket, timers } = setup({ perSec: 10, burst: 3 });
    const { order, take } = taker(bucket);

    void take('a');
    void take('b');
    void take('c');
    void take('d');
    await timers.settle();
    expect(order).toEqual(['a', 'b', 'c']);

    await timers.advance(99);
    expect(order).toEqual(['a', 'b', 'c']);
    await timers.advance(1);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refills at perSec tokens a second and never above the burst', async () => {
    const { bucket, timers } = setup({ perSec: 2, burst: 4 });
    const { take } = taker(bucket);
    void take('a', 4);
    await timers.settle();
    expect(bucket.available()).toBe(0);

    await timers.advance(500);
    expect(bucket.available()).toBe(1);
    await timers.advance(60_000);
    expect(bucket.available()).toBe(4);
  });

  it('serves callers in order: a large request is not overtaken by a small one', async () => {
    const { bucket, timers } = setup({ perSec: 10, burst: 5 });
    const { order, take } = taker(bucket);
    void take('drain', 5);
    void take('big', 5);
    void take('small', 1);
    await timers.settle();
    expect(order).toEqual(['drain']);

    await timers.advance(500);
    expect(order).toEqual(['drain', 'big']);
    await timers.advance(100);
    expect(order).toEqual(['drain', 'big', 'small']);
  });

  it('rejects a request that can never be served, and a bad n', async () => {
    const { bucket } = setup({ perSec: 5, burst: 5 });

    await expect(bucket.take(6)).rejects.toThrow(RangeError);
    await expect(bucket.take(0)).rejects.toThrow(RangeError);
    await expect(bucket.take(1.5)).rejects.toThrow(RangeError);
  });

  it('stops waiting when the signal aborts, and lets the callers behind it through', async () => {
    const { bucket, timers } = setup({ perSec: 10, burst: 1 });
    const { order, take } = taker(bucket);
    const abort = new AbortController();
    void take('first');
    void take('aborted', 1, abort.signal);
    void take('after');
    await timers.settle();

    abort.abort();
    await timers.advance(100);

    expect(order).toEqual(['first', 'aborted!', 'after']);
  });

  it('refuses a call whose signal is already aborted', async () => {
    const { bucket } = setup({ perSec: 10 });
    const abort = new AbortController();
    abort.abort();

    await expect(bucket.take(1, abort.signal)).rejects.toBeInstanceOf(Error);
    expect(bucket.available()).toBe(10);
  });

  it('bounds its waiters (I-6): the call after the limit is refused with BUDGET_EXCEEDED', async () => {
    const { bucket, timers } = setup({ perSec: 1, burst: 1, maxWaiters: 2 });
    const { order, take } = taker(bucket);
    void take('now');
    void take('w1');
    void take('w2');
    await timers.settle();

    await expect(bucket.take(1)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    await timers.advance(2000);
    expect(order).toEqual(['now', 'w1', 'w2']);
  });

  it('checks its options', () => {
    const clock = createManualClock();
    const timers = createManualTimers(clock);

    for (const perSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createTokenBucket({ perSec, clock, timers })).toThrow(
        RangeError,
      );
    }
    expect(() =>
      createTokenBucket({ perSec: 1, burst: 0, clock, timers }),
    ).toThrow(RangeError);
    expect(() =>
      createTokenBucket({ perSec: 1, burst: 1.5, clock, timers }),
    ).toThrow(RangeError);
  });

  it('defaults the burst to perSec, and to 1 below one a second', () => {
    expect(setup({ perSec: 7 }).bucket.available()).toBe(7);
    expect(setup({ perSec: 0.5 }).bucket.available()).toBe(1);
  });
});
