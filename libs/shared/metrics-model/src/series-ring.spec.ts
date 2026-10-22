import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BYTES_PER_POINT,
  RING_MAX_BYTES,
  RING_MAX_POINTS,
  SeriesRing,
} from './series-ring';

describe('M1-54 series ring', () => {
  it('AC-7 the ring is bounded by count and bytes and counts every drop', () => {
    expect(RING_MAX_POINTS).toBe(1000);
    expect(RING_MAX_BYTES).toBe(16_000);
    const push = fc.record({
      t: fc.integer({ min: -5, max: 400 }),
      v: fc.oneof(
        fc.integer({ min: -1000, max: 1000 }),
        fc.constant(Number.NaN),
        fc.constant(Infinity),
      ),
    });
    fc.assert(
      fc.property(
        fc.array(push, { maxLength: 300 }),
        fc.integer({ min: 1, max: 40 }),
        fc.boolean(),
        (pushes, capacity, byBytes) => {
          // The cap may be the count or the bytes: whichever is smaller binds.
          const ring = byBytes
            ? new SeriesRing({
                maxPoints: 1000,
                maxBytes: capacity * BYTES_PER_POINT + 7,
              })
            : new SeriesRing({ maxPoints: capacity });
          expect(ring.capacity).toBe(capacity);
          let lastKept: { t: number; v: number } | null = null;
          for (const p of pushes) {
            if (ring.push(p.t, p.v) === 'kept') lastKept = p;
            expect(ring.length).toBeLessThanOrEqual(capacity);
            expect(ring.bytes).toBeLessThanOrEqual(capacity * BYTES_PER_POINT);
          }
          const held = ring.points();
          // Ascending times, finite values.
          for (let i = 0; i < held.length; i++) {
            expect(Number.isFinite(held[i]?.v)).toBe(true);
            if (i > 0) {
              expect(held[i]?.t ?? NaN).toBeGreaterThan(held[i - 1]?.t ?? NaN);
            }
          }
          // Every offered point is held, evicted or ignored: none is lost without a count.
          const { pushed, evicted, stale } = ring.stats;
          expect(pushed).toBe(pushes.length);
          expect(ring.length + evicted + stale).toBe(pushed);
          // The newest accepted point is always there.
          expect(ring.last() ?? null).toEqual(lastKept);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AC-7 a full ring pushes out its oldest point and says so; a history read replaces without losing the counts', () => {
    const ring = new SeriesRing({ maxPoints: 3 });
    for (const t of [1, 2, 3, 4, 5]) ring.push(t, t * 10);
    expect(ring.points().map((p) => p.t)).toEqual([3, 4, 5]);
    expect(ring.stats).toEqual({ pushed: 5, evicted: 2, stale: 0 });
    // Equal and older times are ignored and counted.
    expect(ring.push(5, 1)).toBe('stale');
    expect(ring.push(4, 1)).toBe('stale');
    expect(ring.push(Number.NaN, 1)).toBe('stale');
    expect(ring.stats).toEqual({ pushed: 8, evicted: 2, stale: 3 });
    // `clear` empties it to be filled again: what it held is taken back out of `pushed`, the drops stay.
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.last()).toBeUndefined();
    expect(ring.stats).toEqual({ pushed: 5, evicted: 2, stale: 3 });
    ring.push(1, 1);
    expect(ring.length + ring.stats.evicted + ring.stats.stale).toBe(
      ring.stats.pushed,
    );
    // The defaults are the documented numbers.
    expect(new SeriesRing().capacity).toBe(1000);
    // A nonsense size still gives a ring that holds a point.
    expect(new SeriesRing({ maxPoints: 0 }).capacity).toBe(1);
  });
});
