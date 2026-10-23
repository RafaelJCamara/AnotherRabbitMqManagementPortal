import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { headersRule, headerValuesEqual, parseXMatch } from './headers.ts';
import type { HeaderTable, HeaderValue } from './types.ts';

const matches = (
  args: HeaderTable | undefined,
  headers?: HeaderTable,
): boolean =>
  headersRule(args === undefined ? {} : { arguments: args }, headers) !== null;

// args, headers, expected. Rows follow rabbit_exchange_type_headers.erl (match/2, match_x/2,
// match_all/3, match_any/3).
const TABLE: readonly (readonly [
  string,
  HeaderTable | undefined,
  HeaderTable | undefined,
  boolean,
])[] = [
  // all (absent x-match)
  [
    'absent: every argument holds',
    { a: 1, b: 'x' },
    { a: 1, b: 'x', c: 2 },
    true,
  ],
  ['absent: one argument missing', { a: 1, b: 'x' }, { a: 1 }, false],
  ['absent: no arguments at all', undefined, { a: 1 }, true],
  ['absent: no message headers', { a: 1 }, undefined, false],
  ['absent: x- argument skipped', { a: 1, 'x-foo': 'z' }, { a: 1 }, true],
  ['all: only x-match', { 'x-match': 'all' }, {}, true],
  ['all: value differs', { 'x-match': 'all', a: 1 }, { a: 2 }, false],
  // any
  ['any: one holds', { 'x-match': 'any', a: 1, b: 2 }, { b: 2 }, true],
  ['any: none holds', { 'x-match': 'any', a: 1, b: 2 }, { c: 3 }, false],
  ['any: no argument', { 'x-match': 'any' }, { a: 1 }, false],
  [
    'any: x- argument skipped',
    { 'x-match': 'any', 'x-foo': 1 },
    { 'x-foo': 1 },
    false,
  ],
  // all-with-x
  [
    'all-with-x: x- argument compared (holds)',
    { 'x-match': 'all-with-x', a: 1, 'x-foo': 'z' },
    { a: 1, 'x-foo': 'z' },
    true,
  ],
  [
    'all-with-x: x- argument compared (missing)',
    { 'x-match': 'all-with-x', a: 1, 'x-foo': 'z' },
    { a: 1 },
    false,
  ],
  ['all-with-x: only x-match', { 'x-match': 'all-with-x' }, {}, true],
  // any-with-x
  [
    'any-with-x: x- argument counts',
    { 'x-match': 'any-with-x', 'x-foo': 1 },
    { 'x-foo': 1 },
    true,
  ],
  [
    'any-with-x: none holds',
    { 'x-match': 'any-with-x', a: 1, 'x-foo': 1 },
    { 'x-foo': 2 },
    false,
  ],
  ['any-with-x: only x-match', { 'x-match': 'any-with-x' }, { a: 1 }, false],
  // void arguments match by presence
  ['void: header present', { a: null }, { a: 'anything' }, true],
  ['void: header absent', { a: null }, {}, false],
  ['void: header present and void', { a: null }, { a: null }, true],
  // unknown or mistyped x-match falls through to all
  [
    'unknown x-match is all (fails)',
    { 'x-match': 'ANY', a: 1, b: 2 },
    { a: 1 },
    false,
  ],
  [
    'unknown x-match is all (holds)',
    { 'x-match': 'ANY', a: 1, b: 2 },
    { a: 1, b: 2 },
    true,
  ],
  ['non-string x-match is all', { 'x-match': 5, a: 1, b: 2 }, { a: 1 }, false],
  // strict equality: no coercion between types
  ['string against number', { a: '1' }, { a: 1 }, false],
  ['boolean against string', { a: true }, { a: 'true' }, false],
  ['array equal', { a: [1, 2] }, { a: [1, 2] }, true],
  ['array order matters', { a: [1, 2] }, { a: [2, 1] }, false],
  ['table equal', { a: { p: 1, q: 'r' } }, { a: { q: 'r', p: 1 } }, true],
  ['table differs', { a: { p: 1 } }, { a: { p: 2 } }, false],
];

describe('routing headers matching', () => {
  it.each(TABLE)('M1-02 AC-1 %s', (_name, args, headers, expected) => {
    expect(matches(args, headers)).toBe(expected);
  });

  it('M1-02 AC-1 the routing key plays no part and the message x- headers are visible', () => {
    expect(
      matches(
        { 'x-match': 'all-with-x', 'x-trace': 'on' },
        { 'x-trace': 'on' },
      ),
    ).toBe(true);
  });

  it('M1-02 AC-1 parses x-match and flags a value the broker would reject when binding', () => {
    expect(parseXMatch(undefined)).toEqual({ mode: 'all', valid: true });
    expect(parseXMatch({ a: 1 })).toEqual({ mode: 'all', valid: true });
    expect(parseXMatch({ 'x-match': 'any-with-x' })).toEqual({
      mode: 'any-with-x',
      valid: true,
    });
    expect(parseXMatch({ 'x-match': 'Any' })).toEqual({
      mode: 'all',
      valid: false,
    });
    expect(parseXMatch({ 'x-match': 7 })).toEqual({
      mode: 'all',
      valid: false,
    });
  });

  it('M1-02 AC-1 names the arguments that decided', () => {
    expect(
      headersRule({ arguments: { 'x-match': 'any', a: 1, b: 2 } }, { b: 2 }),
    ).toEqual({ kind: 'headers', mode: 'any', arguments: ['b'] });
    expect(
      headersRule({ arguments: { a: 1, b: 2, 'x-q': 3 } }, { a: 1, b: 2 }),
    ).toEqual({ kind: 'headers', mode: 'all', arguments: ['a', 'b'] });
  });

  it('M1-02 AC-1 header value equality is structural and strict', () => {
    expect(headerValuesEqual(null, null)).toBe(true);
    expect(headerValuesEqual(null, 0)).toBe(false);
    expect(headerValuesEqual([], {})).toBe(false);
    expect(headerValuesEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(
      true,
    );
    expect(headerValuesEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(headerValuesEqual([1], [1, 2])).toBe(false);
  });

  const KEYS = ['a', 'b', 'c', 'x-a', 'x-b'] as const;
  const value = fc.constantFrom<HeaderValue>(1, 2, '1', null, true);
  const table = fc
    .array(fc.tuple(fc.constantFrom(...KEYS), value), { maxLength: 5 })
    .map((pairs) => Object.fromEntries(pairs) as HeaderTable);
  const message = fc
    .array(fc.tuple(fc.constantFrom(...KEYS), value), { maxLength: 5 })
    .map((pairs) => Object.fromEntries(pairs) as HeaderTable);

  // An independent reading of the four modes.
  function reading(
    mode: string,
    args: HeaderTable,
    headers: HeaderTable,
  ): boolean {
    const compared = Object.entries(args).filter(([name]) =>
      mode.endsWith('-with-x') ? name !== 'x-match' : !name.startsWith('x-'),
    );
    const holds = ([name, wanted]: [string, HeaderValue]): boolean =>
      name in headers &&
      (wanted === null ||
        JSON.stringify(headers[name]) === JSON.stringify(wanted));
    return mode.startsWith('any')
      ? compared.some(holds)
      : compared.every(holds);
  }

  it('M1-02 AC-1 each mode equals an independent reading (property)', () => {
    fc.assert(
      fc.property(
        table,
        message,
        fc.constantFrom('all', 'any', 'all-with-x', 'any-with-x'),
        (args, headers, mode) => {
          const withMode = { ...args, 'x-match': mode } as HeaderTable;
          return (
            matches(withMode, headers) === reading(mode, withMode, headers)
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it('M1-02 AC-1 all-with-x implies all, any implies any-with-x, and an absent x-match is all (property)', () => {
    fc.assert(
      fc.property(table, message, (args, headers) => {
        const plain: Record<string, HeaderValue> = { ...args };
        delete plain['x-match'];
        const run = (mode?: string): boolean =>
          matches(
            mode === undefined ? plain : { ...plain, 'x-match': mode },
            headers,
          );
        return (
          (!run('all-with-x') || run('all')) &&
          (!run('any') || run('any-with-x')) &&
          run() === run('all')
        );
      }),
      { numRuns: 400 },
    );
  });
});
