// Timers as an injected dependency, like the Clock: the scheduler asks for a timer and gets back
// the way to cancel it, so tests (and the model tests of later work packages) control time.
import type { ManualClock } from '../clock/clock.ts';

export interface Timers {
  /** Calls `callback` once after `ms` milliseconds. Returns a function that cancels the timer. */
  setTimer(callback: () => void, ms: number): () => void;
}

/** Real timers. They never keep the process alive. */
export const systemTimers: Timers = {
  setTimer(callback, ms) {
    const handle = setTimeout(callback, Math.max(0, ms));
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface ManualTimers extends Timers {
  /**
   * Moves the clock forward by `ms`, firing every timer that falls due on the way in time order,
   * and lets promise callbacks run after each one.
   */
  advance(ms: number): Promise<void>;
  /** Lets promise callbacks run without moving time. */
  settle(): Promise<void>;
  /** Timers that have not fired and were not cancelled. */
  pending(): number;
}

interface Pending {
  at: number;
  seq: number;
  callback: () => void;
}

/** Timers driven by a ManualClock's monotonic timeline. */
export function createManualTimers(clock: ManualClock): ManualTimers {
  const pending = new Map<number, Pending>();
  let nextSeq = 0;

  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  const earliest = (): Pending | undefined => {
    let best: Pending | undefined;
    for (const timer of pending.values()) {
      if (
        best === undefined ||
        timer.at < best.at ||
        (timer.at === best.at && timer.seq < best.seq)
      ) {
        best = timer;
      }
    }
    return best;
  };

  return {
    setTimer(callback, ms) {
      const seq = nextSeq++;
      pending.set(seq, {
        at: clock.monotonic() + Math.max(0, ms),
        seq,
        callback,
      });
      return () => {
        pending.delete(seq);
      };
    },
    async advance(ms) {
      const target = clock.monotonic() + ms;
      await settle();
      for (;;) {
        const next = earliest();
        if (next === undefined || next.at > target) break;
        pending.delete(next.seq);
        clock.advance(Math.max(0, next.at - clock.monotonic()));
        next.callback();
        await settle();
      }
      clock.advance(Math.max(0, target - clock.monotonic()));
      await settle();
    },
    settle,
    pending: () => pending.size,
  };
}
