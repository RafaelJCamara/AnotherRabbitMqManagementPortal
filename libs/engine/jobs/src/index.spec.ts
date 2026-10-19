import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('jobs public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'HEARTBEAT_MS',
      'JOB_TYPE_PATTERN',
      'LEASE_MS',
      'MAX_SEALED_BYTES',
      'createJobRunner',
      'createMemoryJobStore',
      'createTokenBucket',
      'defineJob',
      'isDefinedJob',
    ]);
  });

  it('keeps the lease at 30 s and the heartbeat at 10 s (blueprint 8)', () => {
    expect(api.LEASE_MS).toBe(30_000);
    expect(api.HEARTBEAT_MS).toBe(10_000);
  });
});
