import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('conformance-ci public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CONFORMANCE_PROJECTS',
      'EXACT_VERSION',
      'JOB_RESULTS',
      'WATCHED_PATHS',
      'parseAffected',
      'parseJobResult',
      'parseLabVersions',
      'planConformance',
      'readLabVersions',
      'verdict',
    ]);
  });
});
