import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('arch-tests public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'FUNNEL_EXEMPT_PREFIXES',
      'PROOF_MINTING_PREFIXES',
      'SCAN_ROOTS',
      'checkMutationFunnel',
      'checkProofMinting',
      'findActionSites',
      'isActionModule',
      'listSources',
      'readFacts',
      'registeredActions',
    ]);
  });
});
