import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ports public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ForgedProofError',
      'LANES',
      'assertAcceptProof',
      'assertAckProof',
      'assertSafeReturnProof',
      'isConfirmedCopyProof',
      'isDestructiveConsentProof',
      'isSafeReturnProof',
      'isStreamCreditProof',
      'mintConfirmedCopyProof',
      'mintDestructiveConsentProof',
      'mintSafeReturnProof',
      'mintStreamCreditProof',
    ]);
  });

  it('lists the lanes from the highest priority to the lowest', () => {
    expect(api.LANES).toEqual(['interactive', 'live', 'background']);
  });
});
