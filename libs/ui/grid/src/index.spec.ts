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
      'DEFAULT_GRID_KEYBINDINGS',
      'DataGrid',
      'GRID_BLOCK_SIZE',
      'GRID_CLIPBOARD',
      'GRID_MAX_BLOCKS',
      'GRID_MAX_COPY_ROWS',
      'GRID_MAX_SELECTION',
      'GRID_MODULE_NAMES',
      'GRID_STYLE_NONCE',
      'GridColumnError',
      'REFRESH_MIN_INTERVAL_MS',
      'WATCH_DEBOUNCE_MS',
      'WindowedDatasource',
      'cellText',
      'defaultColumnState',
      'hideColumn',
      'mapSortModel',
      'matchesChord',
      'moveColumn',
      'normalizeColumnState',
      'resizeColumn',
      'resolveColumns',
      'selectRow',
      'showColumn',
    ]);
    // Nothing exported is an AG Grid module, theme or API object.
    for (const value of Object.values(api)) {
      expect(value).not.toHaveProperty('moduleName');
      expect(value).not.toHaveProperty('withParams');
    }
  });
});
