// `nx run semantics-evidence:check --base=<rev>`: fails when a change to a registry cell, or to the
// evidence tree, breaks invariant I-14 (see check.ts for the rules).
//
//   node --import ./tools/semantics-evidence/register.mjs tools/semantics-evidence/src/cli.ts \
//     --base=origin/main [--repo=owner/name] [--branches=main] [--events=workflow_dispatch] \
//     [--workflow=conformance-record.yml] [--verify-all-runs] [--root=<dir>] [--data=<module>]
//
// The change is `merge-base(<base>, HEAD)` to the working tree, untracked files included. The
// GitHub token for the run check is read from GITHUB_TOKEN or GH_TOKEN, never from an argument.
// It only reads: it never writes to testing/lab-evidence or to the registry.
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { checkEvidence, EVIDENCE_PREFIX, type Finding } from './check.ts';
import {
  createRunVerifier,
  DEFAULT_POLICY,
  githubRunApi,
  type RunApi,
} from './runs.ts';
import { DumpSchema } from './snapshot.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const MAX_FILE = 4 * 1024 * 1024;
const REV = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/;

export class UsageError extends Error {}

export interface Options {
  readonly base: string;
  readonly root: string | undefined;
  readonly data: string | undefined;
  readonly repo: string | undefined;
  readonly branches: readonly string[];
  readonly events: readonly string[];
  readonly workflow: string;
  readonly verifyAllRuns: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let verifyAllRuns = false;
  for (const arg of argv) {
    if (arg === '--verify-all-runs') {
      verifyAllRuns = true;
      continue;
    }
    const match =
      /^--(base|root|data|repo|branches|events|workflow)=(.+)$/.exec(arg);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new UsageError(`unknown argument "${arg}"`);
    }
    values.set(match[1], match[2]);
  }
  const base = values.get('base');
  if (base === undefined || !REV.test(base)) {
    throw new UsageError(
      '--base=<git revision> is required (for example origin/main)',
    );
  }
  const repo = values.get('repo');
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new UsageError('--repo must be owner/name');
  }
  const list = (name: string, fallback: readonly string[]): readonly string[] =>
    values
      .get(name)
      ?.split(',')
      .filter((item) => item !== '') ?? fallback;
  return {
    base,
    root: values.get('root'),
    data: values.get('data'),
    repo,
    branches: list('branches', DEFAULT_POLICY.branches),
    events: list('events', DEFAULT_POLICY.events),
    workflow: values.get('workflow') ?? DEFAULT_POLICY.workflowFile,
    verifyAllRuns,
  };
}

/** The files below the evidence root with their text; null for a link or a file that is too large. */
/** More files than this below the evidence root is an error, not a long read. */
export const MAX_TREE_FILES = 20_000;

export function readTree(
  evidenceRoot: string,
  maxFiles = MAX_TREE_FILES,
): Map<string, string | null> {
  const tree = new Map<string, string | null>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (tree.size >= maxFiles) {
        throw new UsageError(
          `more than ${String(maxFiles)} files below the evidence root`,
        );
      }
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      // lstat, not the directory entry (a Windows junction can read as a plain directory there):
      // a link is neither a directory nor a plain file, so it is recorded as unreadable.
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, `${name}/`);
      else if (!stat.isFile() || stat.size > MAX_FILE) tree.set(name, null);
      else tree.set(name, readFileSync(path, 'utf8'));
    }
  };
  try {
    walk(evidenceRoot, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return tree;
}

const PinsSchema = z.object({
  brokers: z.array(z.object({ version: z.string(), digest: z.string() })),
});

export interface Deps {
  readonly runApi?: RunApi;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: Deps = {},
): Promise<number> {
  const options = parseArgs(argv);
  const root = resolve(options.root ?? join(here, '..', '..', '..'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let mergeBase: string;
  try {
    mergeBase = git('merge-base', options.base, 'HEAD').trim();
  } catch {
    throw new UsageError(
      `cannot find a common ancestor of ${options.base} and HEAD (fetch the base first)`,
    );
  }

  const changed = new Set<string>();
  const tokens = git(
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    mergeBase,
    '--',
    EVIDENCE_PREFIX,
  ).split('\0');
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    changed.add((tokens[i + 1] ?? '').slice(EVIDENCE_PREFIX.length));
  }
  for (const path of git(
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    EVIDENCE_PREFIX,
  ).split('\0')) {
    if (path !== '') changed.add(path.slice(EVIDENCE_PREFIX.length));
  }

  const pins = new Map(
    PinsSchema.parse(
      JSON.parse(
        readFileSync(
          join(root, 'testing', 'broker-lab', 'versions.json'),
          'utf8',
        ),
      ),
    ).brokers.map((broker) => [broker.version, broker.digest]),
  );

  // The registry of a revision is read by a child process that holds no token: it runs the code of
  // the revision under check, which is the thing being checked.
  const clean: Record<string, string | undefined> = { ...process.env };
  delete clean.GITHUB_TOKEN;
  delete clean.GH_TOKEN;
  const dump = (rev: string | undefined) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(here, '..', 'register.mjs')).href,
        join(here, 'dump-cells.ts'),
        ...(options.data === undefined ? [] : [`--data=${options.data}`]),
        ...(rev === undefined
          ? [`--versions=${[...pins.keys()].join(',')}`]
          : []),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...clean,
          SEMANTICS_EVIDENCE_ROOT: root,
          ...(rev === undefined ? {} : { SEMANTICS_EVIDENCE_REV: rev }),
        },
      },
    );
    if (result.status !== 0) {
      throw new UsageError(
        `cannot read the registry of ${rev ?? 'the working tree'}: ${result.stderr.trim()}`,
      );
    }
    return DumpSchema.parse(JSON.parse(result.stdout));
  };
  const base = dump(mergeBase).cells;
  const { cells: head, eras } = dump(undefined);
  const eraOf = (version: string): string | undefined => eras[version];
  const repository =
    options.repo ?? env.GITHUB_REPOSITORY ?? originRepository(git);
  const api =
    deps.runApi ?? githubRunApi({ token: env.GITHUB_TOKEN ?? env.GH_TOKEN });
  const verifier =
    repository === undefined
      ? () =>
          Promise.resolve('the repository is unknown (pass --repo=owner/name)')
      : createRunVerifier(
          {
            ...DEFAULT_POLICY,
            repository,
            branches: options.branches,
            events: options.events,
            workflowFile: options.workflow,
          },
          api,
          (sha) => {
            const result = spawnSync(
              'git',
              ['merge-base', '--is-ancestor', sha, 'HEAD'],
              { cwd: root },
            );
            if (result.status === 0) return Promise.resolve(true);
            if (result.status === 1) return Promise.resolve(false);
            return Promise.reject(
              new Error(`git merge-base failed for ${sha}`),
            );
          },
        );

  const tree = readTree(join(root, EVIDENCE_PREFIX));
  const findings: Finding[] = await checkEvidence({
    base,
    head,
    tree,
    changed,
    pins,
    eraOf,
    verifyRun: verifier,
    verifyAllRuns: options.verifyAllRuns,
  });
  for (const finding of findings) {
    console.error(
      `semantics-evidence: ${finding.subject}: ${finding.message} [${finding.rule}]`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `semantics-evidence: ${String(findings.length)} finding(s) against ${options.base}`,
    );
    return 1;
  }
  console.log(
    `semantics-evidence: ok (${String(head.length)} cell(s), ${String(tree.size)} evidence file(s), ${String(changed.size)} changed against ${options.base})`,
  );
  return 0;
}

function originRepository(
  git: (...args: string[]) => string,
): string | undefined {
  try {
    const url = git('remote', 'get-url', 'origin').trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
  } catch {
    return undefined;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        `semantics-evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
