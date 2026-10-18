import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('live-protocol public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'Credits',
      'DEFAULT_MAX_PARKED',
      'DEFAULT_SESSION_LIMITS',
      'LatestOutbox',
      'LiveSession',
      'LosslessOutbox',
      'MAX_CREDITS',
      'RESUME_WINDOW_MS',
      'ResumeRegistry',
      'SampledOutbox',
      'acceptHello',
      'createOutbox',
      'resumeOutbox',
    ]);
  });
});
