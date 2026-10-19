import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('net-dialer public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'PURPOSES',
      'allowAllPolicy',
      'createDialer',
      'createUndiciConnector',
      'isRegisteredPurpose',
      'systemResolver',
    ]);
  });
});
