// PostToolUse hook for Edit|Write|MultiEdit (M0-07): format and lint the file that was just edited.
//
//   stdin  : { tool_name, tool_input: { file_path }, cwd }
//   exit 0 : the file is clean (it may have been reformatted or auto-fixed in place)
//   exit 2 : problems remain that the agent must fix; they are written to stderr
//
// Steps: `prettier --write`, then `eslint --fix --max-warnings=0` (and prettier once more when
// eslint changed the file). Both tools run through `node <bin>`, so there is no shell and no
// platform-specific syntax.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

import {
  BLOCK,
  isMain,
  locate,
  parsePayload,
  readStdin,
  repoRoot,
  resolveBin,
  stripAnsi,
  targetPath,
} from './lib.mjs';

const PRETTIER_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.json',
  '.css',
  '.yml',
  '.yaml',
]);
const ESLINT_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.json',
]);
const TOOL_TIMEOUT_MS = 120_000;
// Outside `nx`, @nx/enforce-module-boundaries has no project graph and skips itself with a
// warning. That is expected here (the boundaries are checked by `nx lint` and on Stop), so the
// noise is dropped from what the agent sees.
const NX_GRAPH_NOISE =
  /^warning No cached ProjectGraph[\s\S]*?@nx\/enforce-module-boundaries\s*$/gm;

function runNode(root, script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const output = stripAnsi(
    `${result.stdout ?? ''}${result.stderr ?? ''}`,
  ).trim();
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    status: timedOut ? 1 : (result.status ?? 1),
    output: timedOut
      ? `${output}\ntimed out after ${TOOL_TIMEOUT_MS / 1000} s`.trim()
      : output,
    error: result.error && !timedOut ? String(result.error) : undefined,
  };
}

/**
 * Formats and lints one file.
 * @returns {{ ok: boolean, changed: boolean, problems: string[] }}
 */
export function processFile(root, abs) {
  const extension = extname(abs).toLowerCase();
  const problems = [];
  const before = readFileSync(abs, 'utf8');

  const prettier = () => {
    if (!PRETTIER_EXTENSIONS.has(extension)) return;
    // Files in .prettierignore are skipped by prettier itself.
    const run = runNode(root, resolveBin(root, 'prettier'), [
      '--write',
      '--ignore-unknown',
      '--log-level',
      'warn',
      abs,
    ]);
    if (run.status !== 0 || run.error !== undefined) {
      problems.push(
        `prettier could not format the file:\n${run.error ?? run.output}`,
      );
    }
  };

  prettier();

  if (ESLINT_EXTENSIONS.has(extension)) {
    const afterPrettier = readFileSync(abs, 'utf8');
    const run = runNode(root, resolveBin(root, 'eslint'), [
      '--fix',
      '--max-warnings=0',
      '--no-warn-ignored',
      abs,
    ]);
    if (run.status !== 0 || run.error !== undefined) {
      problems.push(
        `eslint reports problems that need a manual fix:\n${run.error ?? run.output.replace(NX_GRAPH_NOISE, '').trim()}`,
      );
    }
    // eslint --fix can leave code that prettier would lay out differently.
    if (readFileSync(abs, 'utf8') !== afterPrettier) prettier();
  }

  return {
    ok: problems.length === 0,
    changed: readFileSync(abs, 'utf8') !== before,
    problems,
  };
}

async function main() {
  const { payload, error } = parsePayload(await readStdin());
  if (error !== undefined) {
    process.stderr.write(`post-edit: ${error}\n`);
    return; // the edit already happened; nothing to report to the agent
  }
  const path = targetPath(payload);
  if (path === undefined) return;

  const root = repoRoot();
  const { abs, rel } = locate(path, root, payload.cwd);
  if (rel === undefined || !existsSync(abs)) return;

  const result = processFile(root, abs);
  if (!result.ok) {
    const note = result.changed
      ? 'The file was reformatted or auto-fixed on disk; re-read it before the next edit.\n'
      : '';
    process.stderr.write(
      `post-edit: ${rel} still has problems after formatting. Fix the cause; do not disable the rule or bypass the hook.\n${note}${result.problems.join('\n')}\n`,
    );
    process.exit(BLOCK);
  }
}

if (isMain(import.meta.url)) await main();
