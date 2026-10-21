import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-grid public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names, and no AG Grid symbol (AC-18, grows with the slices)', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CHANGE_WINDOW_MS',
      'GRID_BLOCK_SIZE',
      'GRID_MAX_BLOCKS',
      'REFRESH_MIN_INTERVAL_MS',
      'WATCH_DEBOUNCE_MS',
      'WindowedDatasource',
      'mapSortModel',
    ]);
  });
});
