import { describe, expect, it } from 'vitest';

import { GRID_MAX_SELECTION, selectRow } from './selection';

describe('selection', () => {
  it('AC-15 selection is by row id and survives block eviction', () => {
    // The set holds ids, never indexes or row objects, so a block leaving the cache cannot touch it.
    let s = selectRow(new Set(), 'multiple', 'row-3', false).selection;
    s = selectRow(s, 'multiple', 'row-90000', true).selection;
    expect([...s]).toEqual(['row-3', 'row-90000']);
    expect(selectRow(s, 'multiple', 'row-3', true).selection.has('row-3')).toBe(
      false,
    );
    expect(selectRow(s, 'multiple', 'row-7', false).selection).toEqual(
      new Set(['row-7']),
    );
    expect(selectRow(s, 'single', 'row-8', true).selection).toEqual(
      new Set(['row-8']),
    );
    expect(
      selectRow(new Set(['row-8']), 'single', 'row-8', true).selection.size,
    ).toBe(0);
    expect(selectRow(s, 'none', 'row-1', false).selection).toBe(s);
  });

  it('the cap refuses an addition past the cap and says so', () => {
    const full = new Set(
      Array.from({ length: GRID_MAX_SELECTION }, (_, i) => `r${String(i)}`),
    );
    const result = selectRow(full, 'multiple', 'extra', true);
    expect(result.refused).toBe(true);
    expect(result.selection).toBe(full);
  });
});
