import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('testkit public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'API',
      'createCaptureStack',
      'createFakeMgmtRead',
      'createFakeMgmtWrite',
      'createRotatingKeyRing',
      'createTestEngine',
      'findBroker',
      'loadBrokerVersions',
      'signLabToken',
      'startBroker',
      'verifyBroker',
      'waitForManagement',
    ]);
  });
});
