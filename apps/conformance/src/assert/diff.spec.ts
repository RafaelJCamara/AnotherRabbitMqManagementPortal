import { describe, expect, it } from 'vitest';
import { diffJson, formatDiffs, MAX_DIFFS } from './diff.ts';

describe('field-level diff', () => {
  it('AC-2 finds nothing between equal values, whatever the key order', () => {
    expect(
      diffJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }),
    ).toEqual([]);
  });

  it('AC-2 names the path of every leaf that differs', () => {
    expect(
      diffJson(
        { steps: [{ result: { redelivered: true, tag: 1 } }], title: 'x' },
        { steps: [{ result: { redelivered: false, tag: 1 } }], title: 'x' },
      ),
    ).toEqual([
      { path: '$.steps[0].result.redelivered', expected: true, actual: false },
    ]);
  });

  it('AC-2 reports a field that only one side has, an array that is longer, and null against absent', () => {
    expect(diffJson({ a: 1 }, { a: 1, b: 2 })).toEqual([
      { path: '$.b', expected: undefined, actual: 2 },
    ]);
    expect(diffJson([1, 2], [1])).toEqual([
      { path: '$[1]', expected: 2, actual: undefined },
    ]);
    expect(diffJson({ a: null }, {})).toEqual([
      { path: '$.a', expected: null, actual: undefined },
    ]);
  });

  it('AC-2 reports a value of another type as one difference, not a tree of them', () => {
    expect(diffJson({ a: [1, 2] }, { a: { 0: 1, 1: 2 } })).toEqual([
      { path: '$.a', expected: [1, 2], actual: { 0: 1, 1: 2 } },
    ]);
    expect(diffJson(1, '1')).toHaveLength(1);
    expect(diffJson([], {})).toHaveLength(1);
  });

  it('formats one line per difference and caps a long list', () => {
    const many = diffJson(
      Array.from({ length: MAX_DIFFS + 5 }, () => 0),
      Array.from({ length: MAX_DIFFS + 5 }, () => 1),
    );

    const lines = formatDiffs(many, {
      expected: 'recorded',
      actual: 'live',
    }).split('\n');

    expect(lines).toHaveLength(MAX_DIFFS + 1);
    expect(lines[0]).toBe('  $[0]: recorded 0, live 1');
    expect(lines.at(-1)).toBe('  ... and 5 more');
    expect(
      formatDiffs(diffJson({ a: 1 }, {}), {
        expected: 'recorded',
        actual: 'live',
      }),
    ).toBe('  $.a: recorded 1, live (absent)');
  });
});
