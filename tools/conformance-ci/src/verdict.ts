// The decision of the required check `conformance` (M0-42). A required check must always report:
// an unaffected change passes on purpose, and anything the plan and the lab jobs cannot vouch for
// fails. The job runs `if: always()`, so a failed, cancelled or skipped `lab` never leaves it green.
export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped';

export const JOB_RESULTS: readonly JobResult[] = [
  'success',
  'failure',
  'cancelled',
  'skipped',
];

export interface VerdictInput {
  /** The plan's `affected` output; undefined when the plan job did not finish or printed nothing usable. */
  readonly affected: boolean | undefined;
  readonly plan: JobResult;
  readonly lab: JobResult;
}

export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

export function verdict(input: VerdictInput): Verdict {
  const { affected, plan, lab } = input;
  if (plan !== 'success') {
    return {
      pass: false,
      reason: `the plan job did not succeed (${plan}), so nobody decided whether the matrix was needed`,
    };
  }
  if (affected === undefined) {
    return {
      pass: false,
      reason: 'the plan did not say whether the change is affected',
    };
  }
  if (!affected) {
    return lab === 'skipped'
      ? {
          pass: true,
          reason:
            'not affected: no conformance project, workflow or evidence file changed, so no broker was started',
        }
      : {
          pass: false,
          reason: `the change is not affected but the lab job was ${lab}, not skipped`,
        };
  }
  return lab === 'success'
    ? {
        pass: true,
        reason: 'affected: every lab version and shard succeeded',
      }
    : {
        pass: false,
        reason: `affected: the lab job was ${lab}, not success`,
      };
}

/** A `needs.<job>.result` value; anything unknown counts as a failure. */
export function parseJobResult(value: string | undefined): JobResult {
  return JOB_RESULTS.find((result) => result === value) ?? 'failure';
}

/** The plan's `affected` output; anything but the two exact words is unreadable. */
export function parseAffected(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
