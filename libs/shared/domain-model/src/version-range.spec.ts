import { describe, expect, it } from 'vitest';
import { parseSemVer, type SemVer } from './semver.ts';
import {
  parseVersionRange,
  rangeIncludes,
  VersionRangeTextSchema,
} from './version-range.ts';

const v = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

/** True when the version text lies in the range text. */
function inRange(range: string, version: string): boolean {
  const parsed = parseVersionRange(range);
  if (parsed === null) throw new Error(`test setup: ${range} does not parse`);
  return rangeIncludes(parsed, v(version));
}

describe('parseVersionRange', () => {
  it.each([
    '',
    '  ',
    '>=',
    '>=4.3.0 <',
    '4.x.3',
    'latest',
    '^4.3.0',
    '~4.3',
    '>4.3.0 ||',
    '<*',
    '4.3.x-rc',
    '>= 4.3.0',
  ])('rejects %j', (text) => {
    expect(parseVersionRange(text)).toBeNull();
    expect(VersionRangeTextSchema.safeParse(text).success).toBe(false);
  });

  it('keeps the trimmed text', () => {
    expect(parseVersionRange('  >=4.3.0  ')?.raw).toBe('>=4.3.0');
  });
});

describe('rangeIncludes', () => {
  it('handles comparators, and the hazard form ">=4.3.0 <4.3.6"', () => {
    const hazard = '>=4.3.0 <4.3.6';
    expect(inRange(hazard, '4.3.0')).toBe(true);
    expect(inRange(hazard, '4.3.5')).toBe(true);
    expect(inRange(hazard, '4.3.6')).toBe(false);
    expect(inRange(hazard, '4.2.9')).toBe(false);
  });

  it('distinguishes <, <=, > and >= at the boundary', () => {
    expect(inRange('<4.3.6', '4.3.6')).toBe(false);
    expect(inRange('<=4.3.6', '4.3.6')).toBe(true);
    expect(inRange('>4.3.6', '4.3.6')).toBe(false);
    expect(inRange('>=4.3.6', '4.3.6')).toBe(true);
    expect(inRange('=4.3.6', '4.3.6')).toBe(true);
    expect(inRange('4.3.6', '4.3.7')).toBe(false);
  });

  it('treats a partial version as the whole line', () => {
    expect(inRange('4.3', '4.3.0')).toBe(true);
    expect(inRange('4.3', '4.3.99')).toBe(true);
    expect(inRange('4.3', '4.4.0')).toBe(false);
    expect(inRange('4.x', '4.0.0')).toBe(true);
    expect(inRange('4.x', '5.0.0')).toBe(false);
    expect(inRange('4.3.x', '4.3.7')).toBe(true);
    expect(inRange('4.3.*', '4.2.9')).toBe(false);
    expect(inRange('>4.3', '4.3.9')).toBe(false);
    expect(inRange('>4.3', '4.4.0')).toBe(true);
    expect(inRange('<=4.3', '4.3.9')).toBe(true);
    expect(inRange('<=4.3', '4.4.0')).toBe(false);
    expect(inRange('<4.3', '4.3.0')).toBe(false);
    expect(inRange('>=4', '4.0.0')).toBe(true);
  });

  it('supports alternatives and the any-version star', () => {
    expect(inRange('<4.0.0 || >=4.3.0 <4.3.6', '3.13.7')).toBe(true);
    expect(inRange('<4.0.0 || >=4.3.0 <4.3.6', '4.1.8')).toBe(false);
    expect(inRange('<4.0.0 || >=4.3.0 <4.3.6', '4.3.2')).toBe(true);
    expect(inRange('*', '9.9.9')).toBe(true);
    expect(inRange('x', '0.0.1')).toBe(true);
  });

  it('compares numerically, not as text (4.2.10 is above 4.2.9)', () => {
    expect(inRange('>4.2.9', '4.2.10')).toBe(true);
    expect(inRange('<=4.2.9', '4.2.10')).toBe(false);
  });

  it('takes pre-releases by plain precedence, which errs towards reporting a hazard', () => {
    expect(inRange('<4.3.6', '4.3.6-rc.1')).toBe(true);
    expect(inRange('>=4.4.0', '4.4.0-alpha.1')).toBe(false);
  });
});
