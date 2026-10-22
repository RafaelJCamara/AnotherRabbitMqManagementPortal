import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('forecast public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_FORECAST_OPTIONS',
      'cleanSeries',
      'counterRate',
      'drainEta',
      'drainEtaFromRates',
      'ewma',
      'linearFit',
      'tQuantile95',
      'timeToLimit',
    ]);
  });
});
