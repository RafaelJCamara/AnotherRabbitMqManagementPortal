import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_TERM_CHARS,
  MAX_TERMS,
  searchTerms,
  toFtsMatch,
  toTsQuery,
} from './capture-search';

describe('capture search text (M1-09)', () => {
  it('M1-09 AC-10 cuts text into letters-and-digits words, lower case, with a star for a prefix', () => {
    expect(searchTerms('Order-123 shipped* CAFÉ')).toEqual([
      { word: 'order', prefix: false },
      { word: '123', prefix: false },
      { word: 'shipped', prefix: true },
      { word: 'café', prefix: false },
    ]);
    expect(searchTerms('  ""  ()  *  ')).toEqual([]);
    expect(searchTerms('')).toEqual([]);
  });

  it('M1-09 AC-10 quotes every term for FTS5 and for Postgres', () => {
    const terms = searchTerms('orders ship* AND');

    expect(toFtsMatch(terms)).toBe('"orders" AND "ship"* AND "and"');
    expect(toTsQuery(terms)).toBe("'orders' & 'ship':* & 'and'");
  });

  it('M1-09 AC-10 bounds the number and the length of the words', () => {
    const many = searchTerms(
      Array.from({ length: 40 }, (_, i) => `w${String(i)}`).join(' '),
    );
    const long = searchTerms('x'.repeat(500));

    expect(many).toHaveLength(MAX_TERMS);
    expect(long[0]?.word).toHaveLength(MAX_TERM_CHARS);
  });

  it('M1-09 AC-10 property: no text yields a query holding anything but quoted words, stars and ANDs', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        const terms = searchTerms(text);
        const fts = toFtsMatch(terms);
        const ts = toTsQuery(terms);

        expect(terms.length).toBeLessThanOrEqual(MAX_TERMS);
        for (const term of terms) {
          expect(term.word).toMatch(/^[\p{L}\p{N}]+$/u);
        }
        // Remove the quoted words, and only operators we wrote ourselves are left.
        expect(
          fts.replace(/"[\p{L}\p{N}]+"\*?/gu, '').replace(/ AND /g, ''),
        ).toBe('');
        expect(
          ts.replace(/'[\p{L}\p{N}]+'(:\*)?/gu, '').replace(/ & /g, ''),
        ).toBe('');
      }),
      { numRuns: 300 },
    );
  });
});
