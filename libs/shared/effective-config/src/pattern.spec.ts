import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { patternProblem, testPattern } from './pattern.ts';

describe('M1-01 AC-12 policy patterns are evaluated only inside a safe subset', () => {
  const accepted = [
    '',
    '.*',
    '^amq\\.',
    '^.*\\.dlq$',
    '^(orders|payments)\\..*',
    'a+b*c?',
    '^[a-z0-9._-]+$',
    '[^abc]',
    '\\d{1,3}',
    '(?:ab){2}',
    '(?!x)orders',
    '(?<=a)b',
    'a.*b.*c.*',
    'x\\.y\\-z\\/w',
    'a*?b',
    '(foo)?bar',
    '(a+)?b',
    'a b',
  ];
  const rejected: readonly [string, string][] = [
    ['\\Aorders', 'uses the escape \\A'],
    [
      '(a+)+$',
      'repeats a group that already contains a quantifier or an alternation',
    ],
    [
      '(a|aa)+$',
      'repeats a group that already contains a quantifier or an alternation',
    ],
    [
      '((a|b)c)*',
      'repeats a group that already contains a quantifier or an alternation',
    ],
    [
      '(a*)*',
      'repeats a group that already contains a quantifier or an alternation',
    ],
    [
      '(a?){5}',
      'repeats a group that already contains a quantifier or an alternation',
    ],
    ['a*a*a*a*', 'has more than 3 unbounded quantifiers'],
    ['.*.*.*.*x', 'has more than 3 unbounded quantifiers'],
    ['a{1001}', 'repeats more than 1000 times'],
    ['a{2,1}', 'has a count whose upper bound is below its lower bound'],
    ['a{x}', 'has a { that is not a count'],
    ['*a', 'has a quantifier * with nothing to repeat'],
    ['a++', 'has a possessive or doubled quantifier'],
    ['a*+', 'has a possessive or doubled quantifier'],
    ['a**', 'has a possessive or doubled quantifier'],
    ['(?i)a', 'uses a group form outside the supported subset'],
    ['(?<n>a)', 'uses a group form outside the supported subset'],
    ['(?>a)', 'uses a group form outside the supported subset'],
    ['(?P<n>a)', 'uses a group form outside the supported subset'],
    ['[[:alpha:]]', 'uses a POSIX class'],
    ['[]a]', 'has a class that starts with ]'],
    ['[^]a]', 'has a class that starts with ]'],
    ['[a', 'has an unclosed class'],
    ['(a', 'has an unclosed group'],
    ['a)', 'has an unmatched )'],
    ['a\\', 'ends with a backslash'],
    ['\\1', 'uses the escape \\1'],
    ['\\_', 'uses the escape \\_'],
    ['a\u001fb', 'contains a non-ASCII or control character'],
    ['a\u007fb', 'contains a non-ASCII or control character'],
    ['[\\p]', 'uses the escape \\p in a class'],
    ['café', 'contains a non-ASCII or control character'],
    ['a\nb', 'contains a non-ASCII or control character'],
    ['a'.repeat(513), 'longer than 512 characters'],
  ];

  for (const pattern of accepted) {
    it(`M1-01 AC-12 accepts ${JSON.stringify(pattern)}`, () => {
      expect(patternProblem(pattern)).toBeNull();
      expect(testPattern(pattern, 'orders.q').ok).toBe(true);
    });
  }

  for (const [pattern, reason] of rejected) {
    it(`M1-01 AC-12 refuses ${JSON.stringify(pattern.slice(0, 20))} and says why`, () => {
      expect(patternProblem(pattern)).toBe(reason);
      expect(testPattern(pattern, 'orders.q')).toEqual({
        ok: false,
        reason: `the pattern ${reason}`,
      });
    });
  }

  it('M1-01 AC-12 the classic catastrophic pattern is never executed against its worst-case name', () => {
    // If this were run on a backtracking engine it would not finish; it is refused instead.
    expect(testPattern('(a+)+$', `${'a'.repeat(250)}!`)).toMatchObject({
      ok: false,
    });
    expect(testPattern('^(a|aa)+$', `${'a'.repeat(250)}!`)).toMatchObject({
      ok: false,
    });
  });

  it('M1-01 AC-12 the heaviest pattern the subset allows finishes on the longest name', () => {
    const result = testPattern('.*a.*a.*b', `${'a'.repeat(254)}!`);

    expect(result).toEqual({ ok: true, matches: false });
  });

  it('M1-01 AC-12 a name the library cannot treat like the broker is uncertain', () => {
    expect(testPattern('.*', 'q'.repeat(256))).toEqual({
      ok: false,
      reason: 'the name is longer than 255 characters',
    });
    expect(testPattern('.*', 'café')).toEqual({
      ok: false,
      reason: 'the name contains a non-ASCII or control character',
    });
    expect(testPattern('.*', 'a\nb')).toMatchObject({ ok: false });
  });

  it('M1-01 AC-12 matching is unanchored and case sensitive', () => {
    expect(testPattern('rder', 'orders')).toEqual({ ok: true, matches: true });
    expect(testPattern('^rder', 'orders')).toEqual({
      ok: true,
      matches: false,
    });
    expect(testPattern('ORDERS', 'orders')).toEqual({
      ok: true,
      matches: false,
    });
    expect(testPattern('^a{2,3}$', 'aaaa')).toEqual({
      ok: true,
      matches: false,
    });
    expect(testPattern('^a{2,3}$', 'aaa')).toEqual({ ok: true, matches: true });
  });

  it('M1-01 AC-12 an expression the engine itself rejects after analysis is uncertain, not an exception', () => {
    // A quantified lookbehind passes the scanner but the engine refuses it.
    expect(patternProblem('(?<=a)*')).toBeNull();
    expect(testPattern('(?<=a)*', 'a')).toEqual({
      ok: false,
      reason: 'the pattern is not a valid expression',
    });
  });

  it('M1-01 AC-12 any pattern over a hostile alphabet is answered without throwing and without a pattern the scanner accepts failing to compile', () => {
    const alphabet = fc.constantFrom(
      ...'ab.*+?()[]{}|^$\\-,:<=!012dwsDWSbB'.split(''),
    );
    fc.assert(
      fc.property(
        fc.array(alphabet, { maxLength: 24 }).map((chars) => chars.join('')),
        (pattern) => {
          const result = testPattern(pattern, 'aab.1');
          if (patternProblem(pattern) === null) {
            // Accepted by the scanner: either it compiled and ran, or the engine said no (a reason).
            if (!result.ok)
              expect(result.reason).toBe(
                'the pattern is not a valid expression',
              );
          } else {
            expect(result.ok).toBe(false);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});
