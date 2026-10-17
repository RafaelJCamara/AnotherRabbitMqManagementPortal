// Shared helpers for the agent hooks (M0-07). Plain Node ESM, no dependencies, no shell.
//
// Hook protocol (Claude Code): the hook receives one JSON object on stdin
// (`tool_name`, `tool_input.file_path`, `cwd`, `stop_hook_active`, ...). Exit 0 lets the action
// go ahead; exit 2 blocks it (PreToolUse, Stop) or feeds stderr back to the agent (PostToolUse).
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Exit code that makes Claude Code surface stderr to the agent. */
export const BLOCK = 2;

/**
 * The repository root. `AGENT_HOOKS_ROOT` is a test seam: the hook tests point it at a throwaway
 * repository. Otherwise it is derived from this file, so the hooks never depend on the cwd.
 */
export function repoRoot() {
  const override = process.env.AGENT_HOOKS_ROOT;
  if (override) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Reads all of stdin. Returns '' when stdin is a terminal, so a manual run never hangs. */
export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parses a hook payload. Empty input is an empty payload; malformed input is reported to the
 * caller (`error`) so each hook can choose to fail open or closed.
 * @param {string} text
 * @returns {{ payload: Record<string, any>, error?: string }}
 */
export function parsePayload(text) {
  if (text.trim() === '') return { payload: {} };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { payload: {}, error: 'hook payload is not a JSON object' };
    }
    return { payload: value };
  } catch (error) {
    return {
      payload: {},
      error: `hook payload is not valid JSON: ${String(error)}`,
    };
  }
}

/** The file a tool call targets, from `tool_input.file_path` (or the notebook/path variants). */
export function targetPath(payload) {
  const input = payload.tool_input;
  if (input === null || typeof input !== 'object') return undefined;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Resolves a tool path against the payload's cwd (or the repository root) and relates it to the
 * root.
 * @returns {{ abs: string, rel: string | undefined }} `rel` is a forward-slash path relative to
 *   the root ('' for the root itself), or undefined when the path is outside the repository.
 */
export function locate(path, root, cwd) {
  const abs = resolve(isAbsolute(path) ? path : resolve(cwd ?? root, path));
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { abs, rel: undefined };
  }
  return { abs, rel: rel.split(sep).join('/') };
}

/** Runs `main` only when the file is executed directly (not when a test imports it). */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === metaUrl;
}

/** Resolves `<package>/<bin>` to an absolute script path from the package's own manifest. */
export function resolveBin(root, packageName, binName = packageName) {
  const manifestPath = resolve(
    root,
    'node_modules',
    packageName,
    'package.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== 'string') {
    throw new Error(`${packageName} declares no "${binName}" bin`);
  }
  return resolve(dirname(manifestPath), bin);
}

/** Strips ANSI colour codes so summaries read well in the agent transcript. */
export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

const ANSI = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);
