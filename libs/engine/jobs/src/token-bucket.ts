// A token bucket for the jobs that must not hurry the broker (replay and move rates, blueprint
// 5.8). `take(n)` waits, in order, until `n` tokens are there. Time comes from the injected Clock
// and Timers, so a test drives it. Waiters are bounded (I-6): a bucket that has a thousand callers
// waiting refuses the next one instead of growing.
import { AppError, BoundedQueue, type Clock, type Timers } from '@app/kernel';

import { abortError } from './abort.ts';

export interface TokenBucketOptions {
  /** Tokens added a second. */
  perSec: number;
  /** The most tokens held at once, and the largest `take`. Default: `perSec`, at least 1. */
  burst?: number;
  clock: Clock;
  timers: Timers;
  /** Callers that may wait at once. Default 1,000. */
  maxWaiters?: number;
}

export interface TokenBucket {
  /** Resolves when `n` tokens (default 1) have been taken; rejects when `signal` aborts. */
  take(n?: number, signal?: AbortSignal): Promise<void>;
  /** Tokens that could be taken now. */
  available(): number;
}

interface Waiter {
  n: number;
  settled: boolean;
  resolve(): void;
  reject(reason: unknown): void;
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { perSec, clock, timers } = options;
  if (!Number.isFinite(perSec) || perSec <= 0) {
    throw new RangeError('A token bucket needs a positive perSec.');
  }
  const burst = options.burst ?? Math.max(1, Math.ceil(perSec));
  if (!Number.isSafeInteger(burst) || burst < 1) {
    throw new RangeError('A token bucket needs a burst of at least 1.');
  }
  const maxWaiters = options.maxWaiters ?? 1000;
  const waiting = new BoundedQueue<Waiter>({
    maxItems: maxWaiters,
    maxBytes: maxWaiters,
    sizeOf: () => 1,
  });
  let tokens = burst;
  let refilledAt = clock.monotonic();
  let cancelTimer: (() => void) | undefined;

  const refill = (): void => {
    const now = clock.monotonic();
    tokens = Math.min(burst, tokens + ((now - refilledAt) * perSec) / 1000);
    refilledAt = now;
  };

  /** Serves waiters from the front while tokens last; otherwise sleeps until the head can go. */
  const serve = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    for (let head = waiting.peek(); head !== undefined; head = waiting.peek()) {
      if (head.settled) {
        waiting.shift();
        continue;
      }
      refill();
      if (tokens < head.n) {
        const wait = Math.ceil(((head.n - tokens) * 1000) / perSec);
        cancelTimer = timers.setTimer(serve, wait);
        return;
      }
      tokens -= head.n;
      head.settled = true;
      waiting.shift();
      head.resolve();
    }
  };

  return {
    available() {
      refill();
      return Math.floor(tokens);
    },
    take(n = 1, signal) {
      if (!Number.isSafeInteger(n) || n < 1 || n > burst) {
        return Promise.reject(
          new RangeError(`take(n) needs a whole n from 1 to ${String(burst)}.`),
        );
      }
      if (signal?.aborted === true) return Promise.reject(abortError(signal));
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { n, settled: false, resolve, reject };
        if (!waiting.offer(waiter)) {
          reject(
            new AppError('BUDGET_EXCEEDED', {
              detail: 'Too many callers are waiting for the job throttle.',
            }),
          );
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            if (waiter.settled) return;
            waiter.settled = true;
            reject(abortError(signal));
            serve();
          },
          { once: true },
        );
        serve();
      });
    },
  };
}
