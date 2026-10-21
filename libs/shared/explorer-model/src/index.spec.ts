import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('explorer-model public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'COLUMNS_BY_KIND',
      'EXPLORER_KINDS',
      'FACETS_BY_KIND',
      'FILTER_CAPS',
      'FILTER_DEBOUNCE_MS',
      'SUB_KEYS_BYTES_MAX',
      'SUB_KEYS_MAX',
      'WINDOW_BLOCK',
      'createInventoryWindowSource',
      'facetApplies',
      'fitKeys',
      'isFilterEmpty',
      'isSortable',
      'sanitizeFilter',
      'sortableColumns',
    ]);
  });
});
