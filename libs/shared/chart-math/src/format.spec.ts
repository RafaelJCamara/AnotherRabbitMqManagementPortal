import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatClock, formatValue, type Unit } from './format';

const UNITS: readonly Unit[] = ['messages', 'count', 'bytes', 'per-second'];

describe('M1-54 formatting', () => {
  it('AC-6 values are formatted compactly with their unit', () => {
    expect(formatValue(0, 'messages', 'en')).toBe('0');
    expect(formatValue(999, 'count', 'en')).toBe('999');
    expect(formatValue(1234, 'messages', 'en')).toBe('1.2K');
    expect(formatValue(2_500_000, 'count', 'en')).toBe('2.5M');
    expect(formatValue(0.25, 'per-second', 'en')).toBe('0.25/s');
    expect(formatValue(1500, 'per-second', 'en')).toBe('1.5K/s');
    expect(formatValue(0, 'bytes', 'en')).toBe('0 B');
    expect(formatValue(1023, 'bytes', 'en')).toBe('1,023 B');
    expect(formatValue(1536, 'bytes', 'en')).toBe('1.5 KiB');
    expect(formatValue(1024 ** 3 * 2, 'bytes', 'en')).toBe('2 GiB');
    // A sign is kept, `-0` reads 0, nothing non-finite is printed.
    expect(formatValue(-1500, 'messages', 'en')).toBe('-1.5K');
    expect(formatValue(-2048, 'bytes', 'en')).toBe('-2 KiB');
    expect(formatValue(-0, 'messages', 'en')).toBe('0');
    for (const unit of UNITS) {
      expect(formatValue(Number.NaN, unit, 'en')).toBe('–');
      expect(formatValue(Infinity, unit, 'en')).toBe('–');
    }
    expect(formatClock(Number.NaN, 'en')).toBe('–');
    expect(formatClock(1_760_000_000_000, 'en')).toMatch(/^\d{2}:\d{2}:\d{2}/);
  });

  it('AC-6 any finite value prints, whatever the unit (property)', () => {
    fc.assert(
      fc.property(
        fc.double({
          noNaN: true,
          noDefaultInfinity: true,
          min: -1e18,
          max: 1e18,
        }),
        fc.constantFrom(...UNITS),
        (value, unit) => {
          const text = formatValue(value, unit, 'en');
          expect(text).not.toMatch(/NaN|Infinity/);
          expect(text.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
