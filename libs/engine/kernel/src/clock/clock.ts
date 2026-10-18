// Time as an injected dependency. Engine code asks a Clock, never Date.now() or performance.now(),
// so tests (and the model tests of later work packages) control time.

export interface Clock {
  /** Wall-clock time, in milliseconds since the Unix epoch. It can jump (NTP, sleep, resume). */
  now(): number;
  /**
   * Milliseconds on a monotonic timeline with an arbitrary origin; it never goes backwards. Use it
   * for durations, deadlines and timeouts, never for timestamps that leave the process.
   */
  monotonic(): number;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

/** A clock that moves only when told to; both timelines advance together. */
export interface ManualClock extends Clock {
  /** Moves both timelines forward by `ms` (a non-negative number). */
  advance(ms: number): void;
  /** Sets the wall clock, for example to simulate a resume after sleep. It does not touch `monotonic`. */
  setNow(epochMs: number): void;
}

export function createManualClock(startEpochMs = 0): ManualClock {
  let wall = startEpochMs;
  let monotonic = 0;
  return {
    now: () => wall,
    monotonic: () => monotonic,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('advance(ms) needs a finite, non-negative ms.');
      }
      wall += ms;
      monotonic += ms;
    },
    setNow(epochMs) {
      if (!Number.isFinite(epochMs)) {
        throw new RangeError('setNow(epochMs) needs a finite number.');
      }
      wall = epochMs;
    },
  };
}
