import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('explorer-model public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'COLUMNS_BY_KIND',
      'DEFAULT_EXCHANGE_LABEL',
      'ENTITY_TAB_IDS',
      'EXPLORER_KINDS',
      'FACETS_BY_KIND',
      'FILTER_CAPS',
      'FILTER_DEBOUNCE_MS',
      'RELATED_SCAN_MAX',
      'RELATED_SHOWN_MAX',
      'SUB_KEYS_BYTES_MAX',
      'SUB_KEYS_MAX',
      'WINDOW_BLOCK',
      'bindingParts',
      'createEntityWatch',
      'createInventoryWindowSource',
      'entityLabel',
      'entityPath',
      'entityUrl',
      'facetApplies',
      'fitKeys',
      'isCertain',
      'isFilterEmpty',
      'isSortable',
      'isStreamRow',
      'loadRelatedBindings',
      'lookupEntity',
      'parseEntityPath',
      'parseViewDefinition',
      'resolveTab',
      'sanitizeFilter',
      'serializeView',
      'sortableColumns',
      'tabSetFor',
    ]);
  });
});
