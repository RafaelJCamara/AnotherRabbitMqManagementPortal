// Entry point of the platform upgrade lane (M0-76, amendment A-25).
//
//   node tools/platform-lane/run-platform-lane.ts detect [--now=<iso>] [--out=<file>]
//        [--summary=<file>] [--github-output=<file>]
//   node tools/platform-lane/run-platform-lane.ts open (--plan-env=<VAR> | --plan=<file>)
//        [--dry-run] [--summary=<file>]
//
// `detect` reads the pins of the repository, asks the registries for newer stable majors old
// enough to adopt, runs the compatibility checks and writes a plan. It needs the network and no
// token. `open` files one `lane:platform` issue per candidate that no issue tracks yet, through
// the `gh` CLI (GH_TOKEN and GH_REPO come from the workflow). Both exit 1 on any failure.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { detect } from './detect.ts';
import {
  LABELS,
  parsePlan,
  renderBody,
  renderReport,
  splitTracked,
  title,
} from './issue.ts';
import type { ExistingIssue } from './issue.ts';
import { parseManifest, readPinSources, resolvePins } from './manifest.ts';
import { httpRegistry } from './registry.ts';

const root = resolve(import.meta.dirname, '..', '..');

function fail(message: string): never {
  console.error(`platform-lane: ${message}`);
  process.exit(1);
}

function appendTo(file: string | undefined, text: string): void {
  if (file !== undefined) appendFileSync(file, text);
}

/** `minimumReleaseAge` of pnpm-workspace.yaml, in minutes: the gate the lane must respect. */
function readAgeGateMinutes(workspaceYaml: string): number {
  const value = (parse(workspaceYaml) as Record<string, unknown> | null)
    ?.minimumReleaseAge;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail('pnpm-workspace.yaml has no positive integer minimumReleaseAge.');
  }
  return value;
}

async function runDetect(values: Record<string, string | boolean | undefined>) {
  const read = (path: string): string => readFileSync(join(root, path), 'utf8');
  const manifest = parseManifest(
    readFileSync(join(import.meta.dirname, 'platforms.json'), 'utf8'),
  );
  const workspaceYaml = read('pnpm-workspace.yaml');
  const sources = readPinSources(
    workspaceYaml,
    read('.nvmrc'),
    read('package.json'),
  );
  const pins = resolvePins(manifest, sources);
  const nowOption = values.now;
  const now = typeof nowOption === 'string' ? new Date(nowOption) : new Date();
  if (Number.isNaN(now.getTime()))
    fail(`--now is not a timestamp: ${String(nowOption)}`);

  const { plan, reports } = await detect({
    manifest,
    pins,
    catalog: sources.catalog,
    registry: httpRegistry(),
    now,
    ageGateMinutes: readAgeGateMinutes(workspaceYaml),
  });

  const json = JSON.stringify(plan);
  if (typeof values.out === 'string') writeFileSync(values.out, `${json}\n`);
  else console.log(json);
  const report = renderReport(reports, plan);
  appendTo(values.summary as string | undefined, `${report}\n`);
  appendTo(
    values['github-output'] as string | undefined,
    `plan=${json}\ncount=${String(plan.candidates.length)}\n`,
  );
  console.error(report);
  const errors = reports.filter((r) => r.status === 'error');
  if (errors.length > 0) {
    fail(
      `${errors.map((r) => r.id).join(', ')} could not be evaluated (see above).`,
    );
  }
}

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function existingIssues(): ExistingIssue[] {
  const out = gh([
    'issue',
    'list',
    '--label',
    LABELS[0],
    '--state',
    'all',
    '--limit',
    '1000',
    '--json',
    'number,state,title,body',
  ]);
  return (JSON.parse(out) as ExistingIssue[]).map((e) => ({
    number: e.number,
    state: e.state,
    title: e.title,
    body: typeof e.body === 'string' ? e.body : '',
  }));
}

function runOpen(values: Record<string, string | boolean | undefined>) {
  const envName = values['plan-env'];
  const file = values.plan;
  let text: string | undefined;
  if (typeof envName === 'string') text = process.env[envName];
  else if (typeof file === 'string') text = readFileSync(file, 'utf8');
  if (text === undefined || text === '')
    fail('no plan given (--plan-env=<VAR> or --plan=<file>).');
  const plan = parsePlan(text);
  const dryRun = values['dry-run'] === true;

  const { toOpen, tracked } = splitTracked(plan.candidates, existingIssues());
  const lines: string[] = [];
  for (const t of tracked) {
    lines.push(
      `Already tracked: ${t.candidate.name} ${String(t.candidate.major)} in #${String(t.issue.number)} (${t.issue.state.toLowerCase()}).`,
    );
  }
  for (const candidate of toOpen) {
    const heading = title(candidate);
    const body = renderBody(candidate, plan.ageGateMinutes);
    if (dryRun) {
      lines.push(`Dry run, would open: ${heading}`);
      console.log(`--- ${heading}\n${body}`);
      continue;
    }
    const url = gh(
      [
        'issue',
        'create',
        '--title',
        heading,
        ...LABELS.flatMap((label) => ['--label', label]),
        '--body-file',
        '-',
      ],
      body,
    ).trim();
    lines.push(`Opened: ${heading} ${url}`);
  }
  if (plan.candidates.length === 0)
    lines.push('No platform has a new major to adopt.');
  for (const line of lines) console.log(line);
  appendTo(
    values.summary as string | undefined,
    `### Issues\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`,
  );
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    now: { type: 'string' },
    out: { type: 'string' },
    summary: { type: 'string' },
    'github-output': { type: 'string' },
    plan: { type: 'string' },
    'plan-env': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

if (command === 'detect') await runDetect(values);
else if (command === 'open') runOpen(values);
else
  fail(
    'usage: run-platform-lane.ts detect|open [options] (see the file header).',
  );
