// PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit (M0-07): blocks edits to human-only paths.
//
//   stdin  : { tool_name, tool_input: { file_path, ... }, cwd }
//   exit 2 : the path is protected; stderr starts with "human-only path" and tells the agent why
//   exit 0 : the edit may go ahead
//
// The list lives in protected-paths.mjs. Matching is case-insensitive (Windows and macOS file
// systems are), and a path outside this checkout is matched by its trailing segments, so a session
// in one worktree cannot edit another checkout's protected files.
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';

import {
  BLOCK,
  isMain,
  locate,
  parsePayload,
  readStdin,
  repoRoot,
  targetPath,
} from './lib.mjs';
import {
  changedSupplyChainKeys,
  findProtected,
  supplyChainKeysIn,
} from './protected-paths.mjs';

const HINT =
  'Agents must not edit it. Ask a maintainer to make the change, or open a draft PR labelled "blocked" that lists what you need.';

/** The file's text after the tool call, or undefined when it cannot be derived. */
function textAfter(before, input) {
  if (typeof input.content === 'string') return input.content; // Write
  const edits = Array.isArray(input.edits)
    ? input.edits // MultiEdit
    : typeof input.old_string === 'string'
      ? [input] // Edit
      : [];
  let text = before;
  for (const edit of edits) {
    if (
      typeof edit.old_string !== 'string' ||
      typeof edit.new_string !== 'string'
    ) {
      return undefined;
    }
    if (!text.includes(edit.old_string)) return undefined;
    text =
      edit.replace_all === true
        ? text.split(edit.old_string).join(edit.new_string)
        : text.replace(edit.old_string, () => edit.new_string);
  }
  return text;
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Supply-chain keys of pnpm-workspace.yaml that this tool call would change. */
function supplyChainChange(abs, input) {
  const before = readOrEmpty(abs);
  const after = textAfter(before, input);
  if (after !== undefined) return changedSupplyChainKeys(before, after);
  // The edit cannot be replayed (the old text is not in the file). Be conservative: block when
  // either side of the edit mentions a policy key.
  const fragments = [input.old_string, input.new_string, input.content].filter(
    (value) => typeof value === 'string',
  );
  for (const edit of Array.isArray(input.edits) ? input.edits : []) {
    fragments.push(edit?.old_string ?? '', edit?.new_string ?? '');
  }
  return supplyChainKeysIn(fragments.join('\n'));
}

/**
 * Decides whether a tool call touches a protected path.
 * @returns {{ blocked: false } | { blocked: true, message: string }}
 */
export function evaluate(payload, root = repoRoot()) {
  const path = targetPath(payload);
  if (path === undefined) return { blocked: false };

  const { abs, rel } = locate(path, root, payload.cwd);
  // Inside this checkout: match the relative path. Outside: match every trailing run of segments,
  // so `<other checkout>/testing/lab-evidence/x.json` is still caught.
  const candidates =
    rel !== undefined
      ? [rel]
      : abs
          .split(sep)
          .map((_, index, parts) => parts.slice(index).join('/'))
          .filter(Boolean);

  for (const candidate of candidates) {
    const entry = findProtected(candidate);
    if (entry === undefined || (entry.localOnly === true && rel === undefined))
      continue;
    if (entry.content === 'pnpm-workspace') {
      const keys = supplyChainChange(abs, payload.tool_input);
      if (keys.length === 0) continue;
      return {
        blocked: true,
        message: `guard-paths: human-only path: ${candidate} (supply-chain keys: ${keys.join(', ')}). ${entry.reason}. ${HINT}`,
      };
    }
    return {
      blocked: true,
      message: `guard-paths: human-only path: ${candidate} (${entry.id}). ${entry.reason}. ${HINT}`,
    };
  }
  return { blocked: false };
}

async function main() {
  const { payload, error } = parsePayload(await readStdin());
  if (error !== undefined) {
    // A guard that cannot read its input must not wave the edit through.
    process.stderr.write(`guard-paths: ${error}\n`);
    process.exit(BLOCK);
  }
  const result = evaluate(payload);
  if (result.blocked) {
    process.stderr.write(`${result.message}\n`);
    process.exit(BLOCK);
  }
}

if (isMain(import.meta.url)) await main();
