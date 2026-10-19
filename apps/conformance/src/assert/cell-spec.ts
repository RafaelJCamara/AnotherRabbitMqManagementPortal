// What every lab-cell spec calls: `describeThreeWay('CF-X-01')` registers one test per lab version
// that evaluates the three-way assertion for that conformance id (three-way.ts, run-case.ts).
//
// Environment (set by `libs/testkit/src/it/run-conformance.ts`, never by hand in CI):
//   LAB_BROKER             the lab broker of this run; without it the live leg is not run
//   CONFORMANCE_VERSIONS   the versions to evaluate (default: every lab version)
//   CONFORMANCE_STRICT=1   an `unverified` result fails (release gate, nightly) instead of being skipped
//   CONFORMANCE_REPORT     a file that every result is appended to, as one JSON line each
import { beforeAll, describe, it } from 'vitest';
import { labVersions, type LabVersion } from './lab-versions.ts';
import { openLiveFromEnv, type LiveBroker, type LiveDeps } from './live.ts';
import { appendReport } from './report.ts';
import { evaluateCase, settleCase, type CaseOptions } from './run-case.ts';

export interface ThreeWayOptions extends CaseOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly versions?: readonly LabVersion[];
  readonly deps?: LiveDeps;
}

export function describeThreeWay(
  cfId: string,
  options: ThreeWayOptions = {},
): void {
  const env = options.env ?? process.env;
  const strict = env.CONFORMANCE_STRICT === '1';
  const wanted = env.CONFORMANCE_VERSIONS?.split(',').filter(
    (version) => version !== '',
  );
  const versions = (options.versions ?? labVersions()).filter(
    (lab) => wanted === undefined || wanted.includes(lab.version),
  );

  describe(cfId, () => {
    let broker: LiveBroker | null = null;
    beforeAll(async () => {
      broker = await openLiveFromEnv(env, options.deps);
    }, 120_000);

    for (const lab of versions) {
      it(`AC-2 ${cfId} on ${lab.version}: the live run, the recorded evidence and the registry cell agree`, async (context) => {
        const results = await evaluateCase(cfId, lab, broker, options);
        appendReport(env.CONFORMANCE_REPORT, results);
        if (settleCase(results, strict) === 'unverified') {
          context.skip('unverified: see the reasons above');
        }
      }, 120_000);
    }
  });
}
