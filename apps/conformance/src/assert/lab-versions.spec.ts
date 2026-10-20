// AC-10 of M0-75: the era of a lab version for the coverage gate comes from the registry's resolver.
import { describe, expect, it } from 'vitest';

import { eraOfVersion, labVersions } from './lab-versions.ts';

describe('lab version eras', () => {
  it('AC-10 a 4.4 lab version has era 4.4 for the coverage gate', () => {
    expect(eraOfVersion('4.4.0')).toBe('4.4');
    expect(eraOfVersion('4.4.2')).toBe('4.4');
    expect(eraOfVersion('4.3.6')).toBe('4.3');
    expect(
      labVersions(new Map([['4.4.0', 'sha256:x']])).map((v) => v.era),
    ).toEqual(['4.4']);
  });
});
