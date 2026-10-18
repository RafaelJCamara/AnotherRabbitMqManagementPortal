import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('domain-model public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BROKER_PROFILE_SCHEMA_VERSION',
      'BrokerProfileSchema',
      'BuildSchema',
      'ERAS',
      'EraSchema',
      'ProductSchema',
      'ProviderSchema',
      'QueueTypeSchema',
      'SemVerSchema',
      'VerificationSchema',
      'VersionRangeTextSchema',
      'compareSemVer',
      'formatCoreVersion',
      'lowestSemVer',
      'parseSemVer',
      'parseVersionRange',
      'rangeIncludes',
    ]);
  });
});
