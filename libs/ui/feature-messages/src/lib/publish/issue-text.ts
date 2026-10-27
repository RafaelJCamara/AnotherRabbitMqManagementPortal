// The words of a draft issue: one key per code, params from the issue (R12). The keys are literals so the source
// check can see every one of them.
import type { DraftIssue } from './draft';
import type { Translate } from '../translate';

const KEYS: Readonly<Record<DraftIssue['code'], string>> = {
  required: 'publish.issues.required',
  'too-long': 'publish.issues.tooLong',
  'out-of-range': 'publish.issues.outOfRange',
  'invalid-base64': 'publish.issues.invalidBase64',
  'invalid-json': 'publish.issues.invalidJson',
  'over-limit': 'publish.issues.overLimit',
  'too-many': 'publish.issues.tooMany',
  'too-deep': 'publish.issues.tooDeep',
  duplicate: 'publish.issues.duplicate',
  'bad-value': 'publish.issues.badValue',
  'name-required': 'publish.issues.nameRequired',
  invalid: 'publish.issues.invalid',
};

/** The words of an issue; where it is does not change them. */
export function issueText(
  t: Translate,
  issue: Pick<DraftIssue, 'code' | 'limit' | 'min' | 'name'>,
): string {
  return t(KEYS[issue.code], {
    limit: issue.limit ?? 0,
    min: issue.min ?? 0,
    name: issue.name ?? '',
  });
}

/** The issues of one field, in order. */
export const issuesOf = (
  issues: readonly DraftIssue[],
  field: string,
): DraftIssue[] => issues.filter((issue) => issue.field === field);
