import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('semantics-evidence public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_POLICY',
      'EVIDENCE_PREFIX',
      'EvidenceFormatError',
      'canonicalJson',
      'checkEvidence',
      'createRunVerifier',
      'digestOf',
      'githubRunApi',
      'parseEvidence',
    ]);
  });
});
