import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('effective-config public API', () => {
  // Update this list, and the README, together with every export you add.
  it('M1-01 AC-13 exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ResolveInputSchema',
      'combine',
      'describeValue',
      'mergeDetails',
      'mergeOperator',
      'parseResolveInput',
      'resolveEffective',
    ]);
  });
});
