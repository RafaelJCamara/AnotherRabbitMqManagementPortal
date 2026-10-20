// The `report` job of the conformance-nightly workflow.
//
//   PLAN_RESULT=<needs.plan.result> PLAN_RELEASE=<matrix json> PLAN_ALPHA=<matrix json> \
//   RELEASE_RESULT=<needs.release.result> ALPHA_RESULT=<needs.alpha.result> \
//   node tools/conformance-ci/src/report-cli.ts [--legs=dist/legs] [--out=dist/nightly-report.md]
//
// Reads what each leg uploaded (`<legs>/leg-node-<node>-<channel>-<version>/result`, the job
// status word), builds the table, writes it to the step summary and to --out, and exits 1 when a
// blocking leg did not succeed. It reads no registry and no evidence, and writes only those two
// places. Node built-ins only.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  nightlyLegs,
  nightlyReport,
  parseLegResult,
  parseNightlyPlan,
} from './nightly.ts';
import { parseJobResult } from './verdict.ts';
import type { JobResult } from './verdict.ts';

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return (
    process.argv
      .slice(2)
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length) ?? fallback
  );
}

const env = process.env;
const legsDir = resolve(flag('legs', 'dist/legs'));
const out = resolve(flag('out', 'dist/nightly-report.md'));

const reported = new Map<string, JobResult>();
if (existsSync(legsDir)) {
  for (const entry of readdirSync(legsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('leg-')) continue;
    const file = join(legsDir, entry.name, 'result');
    if (!existsSync(file)) continue;
    const result = parseLegResult(readFileSync(file, 'utf8'));
    if (result !== undefined) reported.set(entry.name, result);
  }
}

const legs = nightlyLegs({
  planResult: parseJobResult(env.PLAN_RESULT),
  plan: parseNightlyPlan(env.PLAN_RELEASE ?? '', env.PLAN_ALPHA ?? ''),
  releaseResult: parseJobResult(env.RELEASE_RESULT),
  alphaResult: parseJobResult(env.ALPHA_RESULT),
  reported,
});
const report = nightlyReport(legs);

console.log(report.markdown);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, report.markdown);
const summary = env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, `${report.markdown}\n`);
}
process.exit(report.exitCode);
