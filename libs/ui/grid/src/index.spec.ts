import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-grid public API', () => {
  // Update this list, and the README, together with every export you add.
  it('AC-18 the public API exports exactly the documented names and no AG Grid symbol', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CHANGE_WINDOW_MS',
      'COLUMN_DEFAULT_WIDTH',
      'COLUMN_MAX_WIDTH',
      'COLUMN_MIN_WIDTH',
      'GRID_BLOCK_SIZE',
      'GRID_MAX_BLOCKS',
      'GRID_MAX_SELECTION',
      'GridColumnError',
      'REFRESH_MIN_INTERVAL_MS',
      'WATCH_DEBOUNCE_MS',
      'WindowedDatasource',
      'cellText',
      'defaultColumnState',
      'hideColumn',
      'mapSortModel',
      'moveColumn',
      'normalizeColumnState',
      'resizeColumn',
      'resolveColumns',
      'selectRow',
      'showColumn',
    ]);
  });
});
