// Stop hook (M0-07): before the agent finishes, run the affected lint, typecheck and tests.
//
//   stdin  : { stop_hook_active, cwd, ... }
//   exit 0 : nothing changed, the checks pass, or stop_hook_active is set (never loop)
//   exit 2 : the checks failed; a summary is written to stderr so the agent keeps working
//
// Runs `nx affected -t lint typecheck test --base=origin/main --parallel=3` (plus
// `contracts:api-docs-check` when libs/shared/contracts changed and the project defines that
// target). Nx is started through `node <bin>`, so no shell is involved.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BLOCK,
  isMain,
  parsePayload,
  readStdin,
  repoRoot,
  resolveBin,
  stripAnsi,
} from './lib.mjs';

const TIMEOUT_MS = 840_000; // the hook timeout in .claude/settings.json is 900 s
const TAIL_LINES = 60;
const CONTRACTS_DIR = 'libs/shared/contracts/';

const tail = (text, lines = TAIL_LINES) =>
  text.trim().split(/\r?\n/).slice(-lines).join('\n');

/**
 * @typedef {{
 *   git: (args: string[]) => { status: number, stdout: string },
 *   nx: (args: string[]) => { status: number, output: string, timedOut: boolean },
 *   hasTarget: (project: string, target: string) => boolean,
 * }} Io
 */

/** Picks the comparison base: origin/main, else main, else HEAD (uncommitted changes only). */
function resolveBase(io) {
  for (const ref of ['origin/main', 'main']) {
    if (
      io.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status ===
      0
    )
      return ref;
  }
  return 'HEAD';
}

/** Files changed on this branch and in the working tree, relative to the merge base. */
function changedFiles(io, base) {
  const mergeBase = io.git(['merge-base', base, 'HEAD']);
  const since = mergeBase.status === 0 ? mergeBase.stdout.trim() : 'HEAD';
  const tracked = io.git(['diff', '--name-only', since]).stdout;
  const untracked = io.git([
    'ls-files',
    '--others',
    '--exclude-standard',
  ]).stdout;
  return `${tracked}\n${untracked}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Decides whether the agent may stop.
 * @param {Record<string, any>} payload
 * @param {Io} io
 * @returns {{ code: 0 | 2, message?: string }}
 */
export function evaluate(payload, io) {
  if (payload.stop_hook_active === true) return { code: 0 };

  const base = resolveBase(io);
  const files = changedFiles(io, base);
  if (files.length === 0) return { code: 0 };

  const failures = [];
  const affected = io.nx([
    'affected',
    '-t',
    'lint',
    'typecheck',
    'test',
    `--base=${base}`,
    '--parallel=3',
  ]);
  if (affected.status !== 0) {
    failures.push(
      `nx affected -t lint typecheck test --base=${base} ${affected.timedOut ? 'timed out' : `failed (exit ${affected.status})`}:\n${tail(affected.output)}`,
    );
  }

  if (
    files.some((file) => file.startsWith(CONTRACTS_DIR)) &&
    io.hasTarget('contracts', 'api-docs-check')
  ) {
    const docs = io.nx(['run', 'contracts:api-docs-check']);
    if (docs.status !== 0) {
      failures.push(
        `nx run contracts:api-docs-check ${docs.timedOut ? 'timed out' : `failed (exit ${docs.status})`}:\n${tail(docs.output)}`,
      );
    }
  }

  if (failures.length === 0) return { code: 0 };
  return {
    code: BLOCK,
    message: `on-stop: the affected checks fail, so the work is not finished. Fix the cause (do not skip, disable or loosen a check), then finish again.\n\n${failures.join('\n\n')}`,
  };
}

/** The real git and nx, rooted at `root`. */
function realIo(root) {
  const run = (command, args, timeout) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      output: stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`),
      timedOut: result.error?.code === 'ETIMEDOUT',
    };
  };
  return {
    git: (args) => run('git', args, 30_000),
    nx: (args) =>
      run(process.execPath, [resolveBin(root, 'nx'), ...args], TIMEOUT_MS),
    hasTarget(project, target) {
      const file = resolve(root, 'libs', 'shared', project, 'project.json');
      if (!existsSync(file)) return false;
      try {
        return Object.hasOwn(
          JSON.parse(readFileSync(file, 'utf8')).targets ?? {},
          target,
        );
      } catch {
        return false;
      }
    },
  };
}

async function main() {
  const { payload, error } = parsePayload(await readStdin());
  if (error !== undefined) {
    process.stderr.write(`on-stop: ${error}\n`);
    return;
  }
  const result = evaluate(payload, realIo(repoRoot()));
  if (result.code !== 0) {
    process.stderr.write(`${result.message ?? 'on-stop: checks failed'}\n`);
    process.exit(result.code);
  }
}

if (isMain(import.meta.url)) await main();
