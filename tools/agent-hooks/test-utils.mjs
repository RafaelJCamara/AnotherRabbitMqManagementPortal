// Helpers shared by the agent-hooks tests (not a test file itself).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..', '..');
export const hooksDir = import.meta.dirname;

/**
 * Runs a hook script the way Claude Code does: a node process with the payload on stdin.
 * @param {string} script file name inside tools/agent-hooks
 * @param {unknown} payload an object (serialised) or a raw string
 * @param {Record<string, string>} [env]
 */
export function runHook(script, payload, env = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [join(hooksDir, script)], {
    input,
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Creates a throwaway directory with the given files; call `cleanup` when done. */
export function tempTree(files, parent = tmpdir()) {
  // Not git-ignored on purpose: prettier skips git-ignored files, and the tests need it to format them.
  const dir = mkdtempSync(join(parent, 'tmp-'));
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
