import { describe, expect, it } from 'vitest';

import { validateBinding } from './validate-binding.ts';

describe('validateBinding', () => {
  it('M1-02 AC-13 headers: x-match must be one of the four strings', () => {
    for (const mode of ['all', 'any', 'all-with-x', 'any-with-x']) {
      expect(
        validateBinding('headers', {
          routingKey: '',
          arguments: { 'x-match': mode },
        }),
      ).toEqual([]);
    }
    expect(validateBinding('headers', { routingKey: '' })).toEqual([]);
    expect(
      validateBinding('headers', { routingKey: '', arguments: { a: 1 } }),
    ).toEqual([]);
    expect(
      validateBinding('headers', {
        routingKey: '',
        arguments: { 'x-match': 'ALL' },
      }),
    ).toEqual([{ code: 'invalid-x-match-value', value: 'ALL' }]);
    expect(
      validateBinding('headers', {
        routingKey: '',
        arguments: { 'x-match': '' },
      }),
    ).toEqual([{ code: 'invalid-x-match-value', value: '' }]);
  });

  it('M1-02 AC-13 headers: an x-match of another type is refused, naming the type', () => {
    const kinds: [unknown, string][] = [
      [5, 'number'],
      [true, 'boolean'],
      [null, 'void'],
      [['all'], 'array'],
      [{ a: 1 }, 'table'],
    ];
    for (const [value, valueType] of kinds) {
      expect(
        validateBinding('headers', {
          routingKey: '',
          arguments: { 'x-match': value as never },
        }),
      ).toEqual([{ code: 'invalid-x-match-type', valueType }]);
    }
  });

  it('M1-02 AC-13 topic: more # words than the limit is refused, and no limit means no check', () => {
    const key = (k: string) => ({ routingKey: k });
    expect(
      validateBinding('topic', key('#.a.#.b.#'), { topicMaxHashWildcards: 2 }),
    ).toEqual([{ code: 'too-many-hash-words', count: 3, max: 2 }]);
    expect(
      validateBinding('topic', key('#.a.#'), { topicMaxHashWildcards: 2 }),
    ).toEqual([]);
    expect(
      validateBinding('topic', key('a#.#b.#'), { topicMaxHashWildcards: 0 }),
    ).toEqual([{ code: 'too-many-hash-words', count: 1, max: 0 }]);
    expect(validateBinding('topic', key('#.#.#.#'))).toEqual([]);
    expect(validateBinding('topic', key('#.#.#.#'), {})).toEqual([]);
  });

  it('M1-02 AC-13 direct, fanout and unknown types accept anything', () => {
    for (const type of ['direct', 'fanout', 'x-consistent-hash']) {
      expect(
        validateBinding(
          type,
          { routingKey: '#.#.#', arguments: { 'x-match': 7 } },
          {
            topicMaxHashWildcards: 1,
          },
        ),
      ).toEqual([]);
    }
  });
});
