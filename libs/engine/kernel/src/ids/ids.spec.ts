import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock/clock.ts';
import {
  createIdGenerator,
  isUlid,
  ulidTimestamp,
  type RandomBytes,
} from './ids.ts';

/** A random source that returns the same bytes every time. */
const constant =
  (byte: number): RandomBytes =>
  (length) =>
    new Uint8Array(length).fill(byte);

describe('ulid', () => {
  it('encodes the clock time in the first 10 characters', () => {
    const clock = createManualClock(1_700_000_000_123);
    const ids = createIdGenerator({ clock, randomBytes: constant(7) });
    const id = ids.ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTimestamp(id)).toBe(1_700_000_000_123);
  });

  it('matches a known vector (time 0 and zero randomness)', () => {
    const ids = createIdGenerator({
      clock: createManualClock(0),
      randomBytes: constant(0),
    });
    expect(ids.ulid()).toBe('00000000000000000000000000');
  });

  it('increments within the same millisecond, so ids stay ordered', () => {
    const ids = createIdGenerator({
      clock: createManualClock(5_000),
      randomBytes: constant(0),
    });
    const first = ids.ulid();
    const second = ids.ulid();
    expect(second > first).toBe(true);
    expect(second.slice(0, 10)).toBe(first.slice(0, 10));
  });

  it('moves to the next millisecond instead of wrapping when the random part is exhausted', () => {
    const ids = createIdGenerator({
      clock: createManualClock(5_000),
      randomBytes: constant(0xff),
    });
    const first = ids.ulid();
    const second = ids.ulid();
    expect(second > first).toBe(true);
    expect(ulidTimestamp(second)).toBe(5_001);
  });

  it('keeps increasing when the clock steps backwards', () => {
    const clock = createManualClock(10_000);
    const ids = createIdGenerator({ clock });
    const before = ids.ulid();
    clock.setNow(2_000);
    const after = ids.ulid();
    expect(after > before).toBe(true);
    expect(ulidTimestamp(after)).toBe(10_000);
  });

  it('rejects a clock outside the 48-bit range', () => {
    const clock = createManualClock(-1);
    expect(() => createIdGenerator({ clock }).ulid()).toThrow(RangeError);
    clock.setNow(2 ** 48);
    expect(() => createIdGenerator({ clock }).ulid()).toThrow(RangeError);
    const broken = { now: () => Number.NaN, monotonic: () => 0 };
    expect(() => createIdGenerator({ clock: broken }).ulid()).toThrow(
      RangeError,
    );
  });

  it('recognises only well-formed ULIDs', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 characters
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // I is not in the alphabet
    expect(isUlid('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false); // above 2^128
    expect(() => ulidTimestamp('nope')).toThrow(RangeError);
  });

  it('property: ids are unique, well formed and strictly increasing for any clock path', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 }), {
          minLength: 1,
          maxLength: 60,
        }),
        (steps) => {
          const clock = createManualClock(1_000_000);
          const ids = createIdGenerator({ clock });
          const seen: string[] = [];
          for (const step of steps) {
            // Forward steps through advance, backward ones as a wall-clock jump.
            if (step >= 0) clock.advance(step);
            else clock.setNow(clock.now() + step);
            seen.push(ids.ulid());
          }
          for (const id of seen) expect(isUlid(id)).toBe(true);
          // Strictly increasing means already sorted and without duplicates.
          expect(seen).toEqual([...seen].sort());
          expect(new Set(seen).size).toBe(seen.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: the time encoded in a ULID round-trips', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (time) => {
        const ids = createIdGenerator({
          clock: createManualClock(time),
          randomBytes: constant(0x5a),
        });
        expect(ulidTimestamp(ids.ulid())).toBe(time);
      }),
      { numRuns: 300 },
    );
  });
});

describe('uuid', () => {
  it('formats a version 4 UUID with the RFC 4122 variant', () => {
    const ids = createIdGenerator({ randomBytes: constant(0xff) });
    expect(ids.uuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    const real = createIdGenerator().uuid();
    expect(real).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('differs between calls with real randomness', () => {
    const ids = createIdGenerator();
    expect(new Set([ids.uuid(), ids.uuid(), ids.uuid()]).size).toBe(3);
  });
});

describe('typed ids', () => {
  it('mint ULIDs for plans, jobs, receipts and correlation', () => {
    const ids = createIdGenerator({ clock: createManualClock(42) });
    for (const id of [
      ids.planId(),
      ids.jobId(),
      ids.receiptId(),
      ids.correlationId(),
    ]) {
      expect(isUlid(id)).toBe(true);
    }
  });
});
