// The counting limiter of the TokenManager (slice C hardening, F2): how many run at once, in
// which order the rest are let in, what a release or an abort does, and that nothing is left over.
import { describe, expect, it } from 'vitest';

import { createLimiter } from './limiter';

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const never = new AbortController().signal;

describe('limiter', () => {
  it('M1-23 limiter lets at most max run at once and counts who runs and who waits', async () => {
    const limiter = createLimiter(2);
    const a = await limiter.acquire(never);
    const b = await limiter.acquire(never);
    expect(limiter.active).toBe(2);
    let third = false;
    const pending = limiter.acquire(never).then((release) => {
      third = true;
      return release;
    });
    await tick();
    expect(third).toBe(false);
    expect(limiter.waiting).toBe(1);
    expect(limiter.active).toBe(2);
    a();
    const release = await pending;
    expect(third).toBe(true);
    expect(limiter.active).toBe(2); // b, and the third
    expect(limiter.waiting).toBe(0);
    b();
    release();
    expect(limiter.active).toBe(0);
  });

  it('M1-23 limiter lets the waiters in, in the order they came', async () => {
    const limiter = createLimiter(1);
    const first = await limiter.acquire(never);
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      limiter.acquire(never).then((release) => {
        order.push(n);
        release();
      }),
    );
    expect(limiter.waiting).toBe(3);
    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('M1-23 limiter release is idempotent and cannot free a slot it does not hold', async () => {
    const limiter = createLimiter(1);
    const release = await limiter.acquire(never);
    release();
    release();
    expect(limiter.active).toBe(0);
    const again = await limiter.acquire(never);
    release(); // the old handle does not release the new holder's slot
    expect(limiter.active).toBe(1);
    let waiting = false;
    void limiter.acquire(never).then(() => {
      waiting = true;
    });
    release();
    await tick();
    expect(waiting).toBe(false);
    again();
    await tick();
    expect(waiting).toBe(true);
  });

  it('M1-23 limiter refuses at once when the signal is already aborted, with its reason', async () => {
    const limiter = createLimiter(1);
    const reason = new Error('stopped');
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(limiter.acquire(aborted.signal)).rejects.toBe(reason);
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
    // Even when a slot is free.
    const other = new AbortController();
    other.abort();
    await expect(limiter.acquire(other.signal)).rejects.toBeInstanceOf(Error);
    expect(limiter.active).toBe(0);
  });

  it('M1-23 limiter takes a waiter out of the line when its signal aborts, and the others keep their places', async () => {
    const limiter = createLimiter(1);
    const holder = await limiter.acquire(never);
    const leaver = new AbortController();
    const reason = new Error('left');
    const order: string[] = [];
    const left = limiter.acquire(leaver.signal).catch((error: unknown) => {
      order.push('left');
      return error;
    });
    const stays = limiter.acquire(never).then((release) => {
      order.push('stays');
      release();
    });
    expect(limiter.waiting).toBe(2);
    leaver.abort(reason);
    expect(await left).toBe(reason);
    expect(limiter.waiting).toBe(1);
    holder();
    await stays;
    expect(order).toEqual(['left', 'stays']);
    expect(limiter.active).toBe(0);
  });

  it('M1-23 limiter ignores an abort that comes after the slot was granted, and drops its listener', async () => {
    const limiter = createLimiter(1);
    const holder = await limiter.acquire(never);
    const late = new AbortController();
    const granted = limiter.acquire(late.signal);
    holder();
    const release = await granted;
    late.abort(new Error('too late'));
    await tick();
    expect(limiter.active).toBe(1); // still held: the abort did not take it away
    release();
    expect(limiter.active).toBe(0);
  });
});
