// The `plan` job of the conformance-pr workflow, and the dry run `nx run conformance-ci:plan`.
//
//   BASE=<rev> HEAD=<rev> SHARDS=2 node tools/conformance-ci/src/plan-cli.ts
//   node tools/conformance-ci/src/plan-cli.ts --base=origin/main [--head=HEAD] [--shards=2]
//
// Reads git and Nx, writes `affected=` and `matrix=` to $GITHUB_OUTPUT (or prints them when it is
// not set) and the reasons to the step summary. It changes no file of the repository and starts no
// broker. A base that is missing or unreachable, or a failed Nx query, makes the change count as
// affected (the matrix is never skipped on doubt).
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLabVersions, VERSIONS_FILE } from './lab-versions.ts';
import { planConformance } from './plan.ts';
import {
  parseChangedFiles,
  parseProjectList,
  parseRevision,
  parseShards,
  renderOutputs,
} from './plan-input.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function run(command: string, args: string[], quiet: boolean) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // `pnpm` is a script on Windows (a local dry run); the arguments are validated revisions.
    shell: process.platform === 'win32' && command === 'pnpm',
    env: { ...process.env, NX_DAEMON: 'false' },
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  });
}

const base = parseRevision(flag('base') ?? process.env.BASE);
const head = parseRevision(flag('head') ?? process.env.HEAD) ?? 'HEAD';
const notes: string[] = [];

let changedFiles: string[] | null = null;
let affectedProjects: string[] | null = null;
if (base === null) {
  notes.push('no usable base revision');
} else if (
  run('git', ['cat-file', '-e', `${base}^{commit}`], true).status !== 0
) {
  notes.push(`the base ${base} is not a commit of this checkout`);
} else {
  const diff = run('git', ['diff', '--name-only', '-z', base, head], false);
  if (diff.status === 0) changedFiles = parseChangedFiles(diff.stdout);
  else notes.push(`git diff ${base} ${head} failed`);
  const nx = run(
    'pnpm',
    [
      'nx',
      'show',
      'projects',
      '--affected',
      `--base=${base}`,
      `--head=${head}`,
      '--json',
    ],
    false,
  );
  if (nx.status === 0) affectedProjects = parseProjectList(nx.stdout);
  if (affectedProjects === null)
    notes.push('nx show projects --affected failed');
}

const plan = planConformance({
  affectedProjects,
  changedFiles,
  versions: readLabVersions(`${root}${VERSIONS_FILE}`),
  shards: parseShards(flag('shards') ?? process.env.SHARDS),
});

const outputs = renderOutputs(plan);
const lines = [
  `conformance plan: ${plan.affected ? 'affected' : 'not affected'}, ${String(plan.matrix.include.length)} matrix job(s)`,
  ...notes.map((note) => `  note: ${note}`),
  ...plan.reasons.map((reason) => `  reason: ${reason}`),
];
console.log(lines.join('\n'));
const github = process.env.GITHUB_OUTPUT;
if (github !== undefined && github !== '') appendFileSync(github, outputs);
else console.log(outputs);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, `${lines.join('\n')}\n`);
}
