import { describe, expect, it } from 'vitest';

import { DASHES, MARKERS, markerPath, styleOf } from './chart-types';

describe('M1-54 series styles', () => {
  it('AC-16 each series style has its own colour token, dash pattern and marker shape', () => {
    // Colour is never the only signal: six dashes and six shapes, all different.
    expect(new Set(DASHES).size).toBe(6);
    expect(new Set(MARKERS).size).toBe(6);
    const styles = [0, 1, 2, 3, 4, 5].map(styleOf);
    expect(new Set(styles.map((s) => s.colour)).size).toBe(6);
    expect(styles.map((s) => s.colour)).toEqual([
      '--ds-color-chart-1',
      '--ds-color-chart-2',
      '--ds-color-chart-3',
      '--ds-color-chart-4',
      '--ds-color-chart-5',
      '--ds-color-chart-6',
    ]);
    expect(styles[0]?.dash).toBe(''); // the first series is solid
    // More series than styles wrap around, and a junk index is still a style.
    expect(styleOf(6)).toEqual(styleOf(0));
    expect(styleOf(-1)).toEqual(styleOf(5));
    expect(styleOf(2.7)).toEqual(styleOf(2));
    // Every marker is a closed or stroked shape inside its radius box.
    for (const shape of MARKERS) {
      expect(markerPath(shape, 10, 20, 3)).toMatch(/^M[\d. -]+/);
      expect(markerPath(shape, 10, 20, 3)).not.toMatch(/NaN|Infinity/);
    }
    expect(markerPath('square', 10, 20, 3)).toBe('M7 17H13V23H7Z');
  });
});
