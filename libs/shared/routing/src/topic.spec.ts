import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  countHashWords,
  splitTopicKey,
  topicMatches,
  topicRule,
  topicWordsMatch,
} from './topic.ts';

// pattern, key, matches. Each row follows the broker's trie walk
// (rabbit_db_topic_exchange.erl): the empty key has zero words, `*` is one word, `#` zero or more.
const TABLE: readonly (readonly [string, string, boolean])[] = [
  ['a.b', 'a.b', true],
  ['a.b', 'a.c', false],
  ['a.b', 'a', false],
  ['a.*', 'a.b', true],
  ['a.*', 'a', false],
  ['a.*', 'a.b.c', false],
  ['a.*', 'a.', true],
  ['*', '', false],
  ['*', 'a', true],
  ['*', '.', false],
  ['*.*', '.', true],
  ['*.*', 'a.', true],
  ['#', '', true],
  ['#', 'a', true],
  ['#', 'a.b.c', true],
  ['#', '.', true],
  ['a.#', 'a', true],
  ['a.#', 'a.b.c', true],
  ['a.#', 'b', false],
  ['a.#', 'ab', false],
  ['#.b', 'b', true],
  ['#.b', 'a.b', true],
  ['#.b', 'a.b.c', false],
  ['a.#.b', 'a.b', true],
  ['a.#.b', 'a.x.y.b', true],
  ['a.#.b', 'a.x.y', false],
  ['#.#', '', true],
  ['#.*', '', false],
  ['#.*', 'a', true],
  ['*.#', 'a', true],
  ['#.*.#', '', false],
  ['#.*.#', 'x', true],
  ['a.b.#', 'a.b', true],
  ['', '', true],
  ['', 'a', false],
  ['a', '', false],
  ['.', '', false],
  ['.', '.', true],
  ['a..b', 'a..b', true],
  ['a.*.b', 'a..b', true],
  ['a.*.b', 'a.b', false],
  ['a*', 'ab', false],
  ['a*', 'a*', true],
  ['*', '*', true],
  ['#', '#', true],
  ['a.#.#.b', 'a.b', true],
  ['x.*.#', 'x.y', true],
  ['x.*.#', 'x', false],
];

describe('routing topic matching', () => {
  it.each(TABLE)(
    'M1-02 AC-2 pattern %j against key %j is %s',
    (pattern, key, expected) => {
      expect(topicMatches(pattern, key)).toBe(expected);
    },
  );

  it('M1-02 AC-2 the empty key has zero words and a dot has two empty words', () => {
    expect(splitTopicKey('')).toEqual([]);
    expect(splitTopicKey('.')).toEqual(['', '']);
    expect(splitTopicKey('a.')).toEqual(['a', '']);
    expect(splitTopicKey('.a')).toEqual(['', 'a']);
    expect(splitTopicKey('a..b')).toEqual(['a', '', 'b']);
  });

  it('M1-02 AC-2 counts whole # words only', () => {
    expect(countHashWords('#.a.#')).toBe(2);
    expect(countHashWords('a#.#b')).toBe(0);
    expect(countHashWords('#.#.#')).toBe(3);
    expect(countHashWords('')).toBe(0);
  });

  // An independent reading of the same relation: plain backtracking on the word lists.
  function oracle(pattern: readonly string[], key: readonly string[]): boolean {
    if (pattern.length === 0) return key.length === 0;
    const [head, ...rest] = pattern;
    if (head === '#') {
      for (let skip = 0; skip <= key.length; skip += 1) {
        if (oracle(rest, key.slice(skip))) return true;
      }
      return false;
    }
    if (key.length === 0) return false;
    if (head !== '*' && head !== key[0]) return false;
    return oracle(rest, key.slice(1));
  }

  const word = fc.constantFrom('a', 'b', 'c', '', '*', '#', 'ab');
  const keyWord = fc.constantFrom('a', 'b', 'c', '', 'ab', '*', '#');

  it('M1-02 AC-2 the table matcher equals a backtracking oracle', () => {
    fc.assert(
      fc.property(
        fc.array(word, { maxLength: 6 }),
        fc.array(keyWord, { maxLength: 7 }),
        (pattern, key) =>
          topicWordsMatch(pattern, key) === oracle(pattern, key),
      ),
      { numRuns: 500 },
    );
  });

  it('M1-02 AC-2 # matches every key and a pattern without wildcards is string equality', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '', 'zz'), { maxLength: 8 }),
        fc.array(fc.constantFrom('a', 'b', '', 'zz'), { maxLength: 8 }),
        (a, b) => {
          const key = a.join('.');
          const other = b.join('.');
          return (
            topicMatches('#', key) &&
            topicMatches(key, key) &&
            topicMatches(key, other) ===
              (splitTopicKey(key).join('\u0000') ===
                splitTopicKey(other).join('\u0000') &&
                splitTopicKey(key).length === splitTopicKey(other).length)
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('M1-02 AC-2 a long key does not make the matcher exponential', () => {
    const key = Array.from({ length: 250 }, () => 'a').join('.');
    const started = Date.now();
    expect(topicMatches('#.a.#.a.#.b', key)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('M1-02 AC-2 reports the first matching key with its source, and counts words over the limit', () => {
    const keys = [
      { key: 'x.y', source: 'routing-key' as const },
      { key: 'a.b', source: 'cc' as const },
      { key: 'a.c', source: 'bcc' as const },
    ];
    expect(topicRule({ routingKey: 'a.*' }, keys, 256)).toEqual({
      rule: {
        kind: 'topic',
        pattern: 'a.*',
        routingKey: 'a.b',
        keySource: 'cc',
      },
      tooLong: false,
    });
    expect(topicRule({ routingKey: 'q.*' }, keys, 256)).toEqual({
      rule: null,
      tooLong: false,
    });
    // a pattern over the limit never matches and is counted
    expect(topicRule({ routingKey: 'a.b.c' }, keys, 2)).toEqual({
      rule: null,
      tooLong: true,
    });
    // a key over the limit is skipped and counted; the others are still tried
    expect(
      topicRule(
        { routingKey: 'a.*' },
        [{ key: '1.2.3', source: 'routing-key' }, ...keys],
        2,
      ),
    ).toMatchObject({ tooLong: true, rule: { routingKey: 'a.b' } });
  });
});
