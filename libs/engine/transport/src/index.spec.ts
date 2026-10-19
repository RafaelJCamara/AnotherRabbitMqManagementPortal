import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('transport public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'API_PREFIX',
      'CARRIER_HEADER',
      'INTERNAL_HOST',
      'LIVE_PATH',
      'NONCE_PLACEHOLDER',
      'PROBLEM_CONTENT_TYPE',
      'buildApp',
      'contentSecurityPolicy',
      'createCarrierAuth',
      'createLocalTokenAuth',
      'httpError',
      'sendProblem',
    ]);
  });
});
