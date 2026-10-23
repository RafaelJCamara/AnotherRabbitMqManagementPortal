import { describe, expect, it } from 'vitest';
import { combine, mergeOperator } from './merge-operator.ts';
import { policy } from './testing.ts';

const merge = (
  user: Record<string, unknown> | null,
  operator: Record<string, unknown> | null,
) =>
  mergeOperator(
    user === null ? null : policy('user', user),
    operator === null ? null : policy('operator', operator),
  );

describe('M1-01 AC-3 delivery-limit negative rule', () => {
  const cases: readonly [string, number, number, number, string][] = [
    [
      'user -1 and operator 50: the larger, 50',
      -1,
      50,
      50,
      'negative-rule(user, operator)',
    ],
    [
      'user 50 and operator -1: the larger, 50',
      50,
      -1,
      50,
      'negative-rule(user, operator)',
    ],
    [
      'both non-negative: the minimum, 30',
      30,
      50,
      30,
      'negative-rule(user, operator)',
    ],
    [
      'both non-negative, the operator lower: 20',
      50,
      20,
      20,
      'negative-rule(user, operator)',
    ],
    [
      'both negative: the larger, -1',
      -1,
      -2,
      -1,
      'negative-rule(user, operator)',
    ],
    [
      'zero is not negative: the minimum, 0',
      0,
      5,
      0,
      'negative-rule(user, operator)',
    ],
  ];

  for (const [name, user, operator, expected, rule] of cases) {
    it(`M1-01 AC-3 ${name}`, () => {
      const merged = merge(
        { 'delivery-limit': user },
        { 'delivery-limit': operator },
      );

      expect(merged.entries['delivery-limit']).toEqual({
        status: 'value',
        value: expected,
        rule,
      });
    });
  }

  it('M1-01 AC-3 the combine function is the rule, with the boundary at zero', () => {
    expect(combine('negative-rule', -1, 0)).toBe(0);
    expect(combine('negative-rule', 0, 0)).toBe(0);
    expect(combine('negative-rule', 1, 0)).toBe(0);
    expect(combine('negative-rule', -1, -1)).toBe(-1);
    expect(combine('min', 3, 5)).toBe(3);
    expect(combine('max', 3, 5)).toBe(5);
  });
});

describe('M1-01 AC-5 operator merge table', () => {
  const rows: readonly [string, unknown, unknown, unknown, string][] = [
    // Limits: the minimum.
    ['message-ttl', 1000, 500, 500, 'min(user, operator)'],
    ['message-ttl', 500, 1000, 500, 'min(user, operator)'],
    ['max-length', 5, 9, 5, 'min(user, operator)'],
    ['max-length-bytes', 900, 100, 100, 'min(user, operator)'],
    ['max-in-memory-length', 7, 3, 3, 'min(user, operator)'],
    ['max-in-memory-bytes', 70, 30, 30, 'min(user, operator)'],
    ['expires', 10, 20, 10, 'min(user, operator)'],
    // The operator value.
    ['overflow', 'drop-head', 'reject-publish', 'reject-publish', 'operator'],
    ['queue-version', 1, 2, 2, 'operator'],
    ['delayed-retry-type', 'all', 'failed', 'failed', 'operator'],
    // The greater value.
    ['target-group-size', 3, 5, 5, 'max(user, operator)'],
    ['target-group-size', 5, 3, 5, 'max(user, operator)'],
    // Booleans: the operator value.
    ['some-flag', true, false, false, 'operator'],
    ['other-flag', false, true, true, 'operator'],
  ];

  for (const [key, user, operator, expected, rule] of rows) {
    it(`M1-01 AC-5 ${key}: user ${String(user)} and operator ${String(operator)} give ${String(expected)}`, () => {
      const merged = merge({ [key]: user }, { [key]: operator });

      expect(merged.entries[key]).toEqual({
        status: 'value',
        value: expected,
        rule,
      });
    });
  }

  it('M1-01 AC-5 a key in one policy only passes through with no rule, whichever layer holds it', () => {
    const merged = merge(
      { 'max-length': 5, 'ha-params': [1, 2] },
      { 'message-ttl': 9 },
    );

    expect(merged.entries['max-length']).toEqual({
      status: 'value',
      value: 5,
      rule: null,
    });
    expect(merged.entries['message-ttl']).toEqual({
      status: 'value',
      value: 9,
      rule: null,
    });
    expect(merged.entries['ha-params']).toEqual({
      status: 'value',
      value: [1, 2],
      rule: null,
    });
  });

  it('M1-01 AC-5 a key in both with no rule that names it is unknown, not the operator value', () => {
    const merged = merge({ 'max-age': '7D' }, { 'max-age': '1D' });

    expect(merged.entries['max-age']).toEqual({
      status: 'unknown',
      reason: 'no-merge-rule',
      userValue: '7D',
      operatorValue: '1D',
    });
  });

  it('M1-01 AC-5 the boolean rule needs two booleans: a boolean and a string is unknown', () => {
    const merged = merge({ 'some-flag': true }, { 'some-flag': 'yes' });

    expect(merged.entries['some-flag']?.status).toBe('unknown');
  });

  it('M1-01 AC-5 a numeric rule with a value that is not a finite number is invalid and names the layer', () => {
    expect(
      merge({ 'message-ttl': 'soon' }, { 'message-ttl': 5 }).entries[
        'message-ttl'
      ],
    ).toMatchObject({
      status: 'invalid',
      reason: 'user policy value is not a number',
    });
    expect(
      merge({ 'message-ttl': 5 }, { 'message-ttl': Number.NaN }).entries[
        'message-ttl'
      ],
    ).toMatchObject({
      status: 'invalid',
      reason: 'operator policy value is not a number',
    });
    expect(
      merge({ 'max-length': Infinity }, { 'max-length': 5 }).entries[
        'max-length'
      ]?.status,
    ).toBe('invalid');
  });

  it('M1-01 AC-5 the merged policy is marked notEffective and empty policies merge to nothing', () => {
    expect(merge({ 'max-length': 5 }, null).notEffective).toBe(true);
    expect(merge(null, null).entries).toEqual({});
  });
});
