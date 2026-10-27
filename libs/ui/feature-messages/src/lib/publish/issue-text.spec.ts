import { describe, expect, it } from 'vitest';

import en from '../../i18n/en.json';
import type { DraftIssue } from './draft';
import { issueText, issuesOf } from './issue-text';

interface Tree {
  readonly [key: string]: string | Tree;
}

const has = (path: string): boolean => {
  let node: string | Tree | undefined = en;
  for (const part of path.replace(/^publish\./, '').split('.')) {
    node = typeof node === 'string' ? undefined : node?.[part];
  }
  return typeof node === 'string';
};

/** A translate function that shows what it was asked for. */
const echo = (key: string, params?: Record<string, string | number>): string =>
  `${key} ${JSON.stringify(params)}`;

const CODES: DraftIssue['code'][] = [
  'required',
  'too-long',
  'out-of-range',
  'invalid-base64',
  'invalid-json',
  'over-limit',
  'too-many',
  'too-deep',
  'duplicate',
  'bad-value',
  'name-required',
  'invalid',
];

describe('issueText', () => {
  it('asks for one key per code, each of which exists, with the numbers and the name of the issue', () => {
    const keys = CODES.map(
      (code) => /^(\S+)/.exec(issueText(echo, { code }))?.[1],
    );
    expect(new Set(keys).size).toBe(CODES.length);
    for (const key of keys) expect(has(key ?? ''), key).toBe(true);
    expect(keys).toEqual([
      'publish.issues.required',
      'publish.issues.tooLong',
      'publish.issues.outOfRange',
      'publish.issues.invalidBase64',
      'publish.issues.invalidJson',
      'publish.issues.overLimit',
      'publish.issues.tooMany',
      'publish.issues.tooDeep',
      'publish.issues.duplicate',
      'publish.issues.badValue',
      'publish.issues.nameRequired',
      'publish.issues.invalid',
    ]);
    // What the issue does not carry is zero or empty, never missing.
    expect(issueText(echo, { code: 'required' })).toContain(
      '{"limit":0,"min":0,"name":""}',
    );
    expect(
      issueText(echo, {
        code: 'out-of-range',
        limit: 9,
        min: 3,
        name: 'n',
      }),
    ).toContain('{"limit":9,"min":3,"name":"n"}');
  });

  it('picks the issues of one field, exactly, in order', () => {
    const issues: DraftIssue[] = [
      { field: 'headers', code: 'too-many' },
      { field: 'headers.h1', code: 'duplicate' },
      { field: 'headers', code: 'invalid-json' },
    ];
    expect(issuesOf(issues, 'headers').map((issue) => issue.code)).toEqual([
      'too-many',
      'invalid-json',
    ]);
    expect(issuesOf(issues, 'body')).toEqual([]);
  });
});
