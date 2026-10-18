import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareSemVer,
  formatCoreVersion,
  lowestSemVer,
  parseSemVer,
} from './semver.ts';
import type { SemVer } from './semver.ts';

const v = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

describe('parseSemVer', () => {
  it('parses the versions the broker reports', () => {
    expect(parseSemVer('4.3.6')).toEqual({
      major: 4,
      minor: 3,
      patch: 6,
      raw: '4.3.6',
    });
    expect(parseSemVer('4.2.10')).toMatchObject({
      major: 4,
      minor: 2,
      patch: 10,
    });
    expect(parseSemVer('3.13.7')).toMatchObject({
      major: 3,
      minor: 13,
      patch: 7,
    });
  });

  it('keeps pre-release identifiers and drops build metadata from the order', () => {
    expect(parseSemVer('4.4.0-alpha.1a2b3c')).toEqual({
      major: 4,
      minor: 4,
      patch: 0,
      pre: 'alpha.1a2b3c',
      raw: '4.4.0-alpha.1a2b3c',
    });
    expect(parseSemVer('4.3.6+build.5')).toEqual({
      major: 4,
      minor: 3,
      patch: 6,
      raw: '4.3.6+build.5',
    });
  });

  it('accepts a leading v and surrounding whitespace', () => {
    expect(parseSemVer(' v4.3.6 ')).toMatchObject({
      major: 4,
      minor: 3,
      patch: 6,
      raw: 'v4.3.6',
    });
  });

  it.each([
    '',
    '4',
    '4.3',
    '4.3.6.1',
    'a.b.c',
    '04.3.6',
    '4.3.-1',
    '4.3.6-',
    '4.3.6-a..b',
    '4.3.x',
    '99999999999999999999.0.0',
  ])(
    'returns null for the malformed version %j instead of guessing',
    (text) => {
      expect(parseSemVer(text)).toBeNull();
    },
  );
});

describe('compareSemVer', () => {
  it('orders by major, minor, then patch numerically (4.2.10 is above 4.2.9)', () => {
    expect(compareSemVer(v('4.2.10'), v('4.2.9'))).toBe(1);
    expect(compareSemVer(v('4.2.9'), v('4.2.10'))).toBe(-1);
    expect(compareSemVer(v('4.10.0'), v('4.9.9'))).toBe(1);
    expect(compareSemVer(v('3.13.7'), v('4.0.0'))).toBe(-1);
    expect(compareSemVer(v('4.3.6'), v('4.3.6'))).toBe(0);
  });

  it('ranks a pre-release below its release and follows semver 2.0 precedence', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let index = 1; index < ascending.length; index += 1) {
      expect(
        compareSemVer(v(ascending[index - 1] ?? ''), v(ascending[index] ?? '')),
        ascending[index],
      ).toBe(-1);
    }
  });

  it('ignores the raw text and build metadata', () => {
    expect(compareSemVer(v('v4.3.6'), v('4.3.6+abc'))).toBe(0);
  });

  const arbitrary = fc
    .tuple(
      fc.nat(30),
      fc.nat(30),
      fc.nat(30),
      fc.option(fc.constantFrom('alpha', 'alpha.1', 'beta', 'rc.2'), {
        nil: undefined,
      }),
    )
    .map(([major, minor, patch, pre]) =>
      v(
        `${String(major)}.${String(minor)}.${String(patch)}${pre === undefined ? '' : `-${pre}`}`,
      ),
    );

  it('is antisymmetric and transitive', () => {
    fc.assert(
      fc.property(arbitrary, arbitrary, arbitrary, (a, b, c) => {
        expect(compareSemVer(a, b) + compareSemVer(b, a)).toBe(0);
        if (compareSemVer(a, b) <= 0 && compareSemVer(b, c) <= 0) {
          expect(compareSemVer(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('lowestSemVer', () => {
  it('returns the lowest version, and null for an empty list', () => {
    expect(lowestSemVer([v('4.3.6'), v('4.2.9'), v('4.3.0')])?.raw).toBe(
      '4.2.9',
    );
    expect(lowestSemVer([])).toBeNull();
  });
});

describe('formatCoreVersion', () => {
  it('drops pre-release and build parts', () => {
    expect(formatCoreVersion(v('4.4.0-alpha.1+x'))).toBe('4.4.0');
  });
});
