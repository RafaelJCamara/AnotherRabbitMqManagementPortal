import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Credits, MAX_CREDITS } from './credits.ts';

describe('Credits', () => {
  it('grants, consumes and refuses to go below zero', () => {
    const credits = new Credits(1);
    credits.consume();
    expect(credits.available).toBe(0);
    expect(() => {
      credits.consume();
    }).toThrow(RangeError);
    expect(credits.available).toBe(0);
    expect(credits.stats).toEqual({
      granted: 1,
      consumed: 1,
      discarded: 0,
      refused: 0,
    });
  });

  it('saturates at MAX_CREDITS and counts what it refused', () => {
    const credits = new Credits(MAX_CREDITS - 1);
    expect(credits.grant(5)).toBe(1);
    expect(credits.available).toBe(MAX_CREDITS);
    expect(credits.stats.refused).toBe(4);
  });

  it('rejects fractions and negatives', () => {
    expect(() => new Credits(-1)).toThrow(RangeError);
    expect(() => new Credits(0).grant(1.5)).toThrow(RangeError);
  });

  it('reset discards the balance and counts it', () => {
    const credits = new Credits(5);
    credits.consume();
    credits.reset();
    expect(credits.available).toBe(0);
    expect(credits.stats.discarded).toBe(4);
  });

  it('keeps granted = consumed + discarded + available under any operation sequence', () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant('grant'), n: fc.nat(2_000_000) }),
      fc.record({ k: fc.constant('consume'), n: fc.constant(0) }),
      fc.record({ k: fc.constant('reset'), n: fc.constant(0) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const credits = new Credits();
        for (const { k, n } of ops) {
          if (k === 'grant') credits.grant(n);
          else if (k === 'reset') credits.reset();
          else if (credits.available > 0) credits.consume();
          const s = credits.stats;
          expect(credits.available).toBeGreaterThanOrEqual(0);
          expect(credits.available).toBeLessThanOrEqual(MAX_CREDITS);
          expect(s.granted).toBe(s.consumed + s.discarded + credits.available);
        }
      }),
    );
  });
});
