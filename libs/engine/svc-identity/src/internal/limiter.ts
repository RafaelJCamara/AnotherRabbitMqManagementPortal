// A counting limiter for provider calls: at most `max` run at once, the rest wait in order. Waiting
// is bounded by the caller (the manager has one flight per tracked connection, and at most
// `maxEntries` of them), and a waiter whose signal aborts leaves the line and rejects with the
// signal's reason.
import { abortReason } from './signals';

export interface Limiter {
  /** Resolves with a `release` once a slot is free. `release` is idempotent. */
  acquire(signal: AbortSignal): Promise<() => void>;
  readonly active: number;
  readonly waiting: number;
}

interface Waiter {
  grant(): void;
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiters: Waiter[] = [];

  const take = (): (() => void) => {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      waiters.shift()?.grant();
    };
  };

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(abortReason(signal));
      if (active < max) return Promise.resolve(take());
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = {
          grant: () => {
            signal.removeEventListener('abort', onAbort);
            resolve(take());
          },
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
