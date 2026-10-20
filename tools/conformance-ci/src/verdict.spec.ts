import { describe, expect, it } from 'vitest';
import {
  JOB_RESULTS,
  parseAffected,
  parseJobResult,
  verdict,
} from './verdict.ts';
import type { JobResult } from './verdict.ts';

describe('verdict', () => {
  it('AC-4 the conformance check passes only when it should, over every result combination', () => {
    const affectedValues = [true, false, undefined] as const;
    let combinations = 0;
    for (const affected of affectedValues) {
      for (const plan of JOB_RESULTS) {
        for (const lab of JOB_RESULTS) {
          combinations += 1;
          // The oracle, written from the criterion rather than from the implementation.
          const shouldPass =
            plan === 'success' &&
            ((affected === true && lab === 'success') ||
              (affected === false && lab === 'skipped'));
          const decision = verdict({ affected, plan, lab });
          expect(
            decision.pass,
            `affected=${String(affected)} plan=${plan} lab=${lab}`,
          ).toBe(shouldPass);
          expect(decision.reason).not.toBe('');
        }
      }
    }
    expect(combinations).toBe(48);
    // The reasons name what happened.
    expect(
      verdict({ affected: true, plan: 'success', lab: 'failure' }).reason,
    ).toMatch(/lab job was failure/);
    expect(
      verdict({ affected: true, plan: 'success', lab: 'skipped' }).reason,
    ).toMatch(/lab job was skipped/);
    expect(
      verdict({ affected: true, plan: 'failure', lab: 'skipped' }).reason,
    ).toMatch(/plan job did not succeed/);
    expect(
      verdict({ affected: undefined, plan: 'success', lab: 'skipped' }).reason,
    ).toMatch(/did not say/);
    expect(
      verdict({ affected: false, plan: 'success', lab: 'skipped' }).reason,
    ).toMatch(/not affected/);
  });

  it('reads job results and the affected output strictly', () => {
    for (const result of JOB_RESULTS) {
      expect(parseJobResult(result)).toBe(result);
    }
    for (const bad of [
      undefined,
      '',
      'Success',
      'passed',
      'success ',
    ] satisfies (string | undefined)[]) {
      expect(parseJobResult(bad)).toBe<JobResult>('failure');
    }
    expect(parseAffected('true')).toBe(true);
    expect(parseAffected('false')).toBe(false);
    for (const bad of [undefined, '', 'True', '1', 'yes', 'true\n']) {
      expect(parseAffected(bad)).toBeUndefined();
    }
  });
});
