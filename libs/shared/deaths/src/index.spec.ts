import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('deaths public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEATH_REASONS',
      'INTERPRETED_CAPABILITY',
      'LIMITS',
      'REPLAY_STAMPS',
      'REPUBLISH_MARKERS',
      'deathContext',
      'normalizeDeaths',
      'readDeathEntries',
    ]);
  });
});
