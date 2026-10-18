import { describe, expect, it } from 'vitest';

import { createManualClock, systemClock } from './clock.ts';

describe('systemClock', () => {
  it('reports wall time near Date.now() and a monotonic time that never goes back', () => {
    const before = Date.now();
    const wall = systemClock.now();
    expect(wall).toBeGreaterThanOrEqual(before);
    expect(wall).toBeLessThanOrEqual(Date.now());

    let last = systemClock.monotonic();
    for (let i = 0; i < 1000; i += 1) {
      const next = systemClock.monotonic();
      expect(next).toBeGreaterThanOrEqual(last);
      last = next;
    }
  });
});

describe('createManualClock', () => {
  it('starts where it is told and advances both timelines', () => {
    const clock = createManualClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.monotonic()).toBe(0);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
    expect(clock.monotonic()).toBe(250);
  });

  it('can jump the wall clock without moving the monotonic one', () => {
    const clock = createManualClock(0);
    clock.advance(10);
    clock.setNow(60_000);
    expect(clock.now()).toBe(60_000);
    expect(clock.monotonic()).toBe(10);
  });

  it('refuses to go backwards or to take non-finite values', () => {
    const clock = createManualClock(0);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      clock.setNow(Infinity);
    }).toThrow(RangeError);
    expect(clock.now()).toBe(0);
  });
});
