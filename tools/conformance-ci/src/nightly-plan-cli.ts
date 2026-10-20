// The `plan` job of the conformance-nightly workflow.
//
//   [ALPHA_VERSIONS=<comma list>] node tools/conformance-ci/src/nightly-plan-cli.ts
//
// Writes `release=`, `alpha=` (matrices) and `has_alpha=` to $GITHUB_OUTPUT (or prints them when
// it is not set). The release matrix is every pinned lab version on every nightly Node, exact
// versions only. The alpha list is empty until the source and pinning rule of non-release builds
// are settled (OQ-81): the workflow does not set ALPHA_VERSIONS today.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLabVersions, VERSIONS_FILE } from './lab-versions.ts';
import { planNightly } from './nightly.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const alphaVersions = (process.env.ALPHA_VERSIONS ?? '')
  .split(',')
  .map((version) => version.trim())
  .filter((version) => version !== '');

const plan = planNightly({
  versions: readLabVersions(`${root}${VERSIONS_FILE}`),
  alphaVersions,
});
const outputs = [
  `release=${JSON.stringify(plan.release)}`,
  `alpha=${JSON.stringify(plan.alpha)}`,
  `has_alpha=${String(plan.hasAlpha)}`,
  '',
].join('\n');
console.log(
  `conformance nightly plan: ${String(plan.release.include.length)} release leg(s), ${String(plan.alpha.include.length)} alpha leg(s)`,
);
const github = process.env.GITHUB_OUTPUT;
if (github !== undefined && github !== '') appendFileSync(github, outputs);
else console.log(outputs);
