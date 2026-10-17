// Helpers for the generator unit tests: an in-memory workspace that carries the real policy
// files the generators edit, and a way to see exactly what a generator created or changed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { format } from 'prettier';
import { expect } from 'vitest';

export const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

/** Real files from this repository that generators read or edit. */
const REAL_FILES = [
  'eslint.config.mjs',
  'tsconfig.base.json',
  '.prettierrc',
  'tools/eslint-rules/src/index.ts',
  'tools/eslint-rules/README.md',
  'tools/lint-selftest/src/project-rules.spec.ts',
  'tools/supply-chain/deps-allowlist.json',
];

export function workspaceTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  for (const path of REAL_FILES) {
    tree.write(path, readFileSync(join(repoRoot, path), 'utf8'));
  }
  return tree;
}

export type Files = Record<string, string>;

/** Every file in the tree, by path. */
export function filesOf(tree: Tree): Files {
  const files: Files = {};
  for (const change of tree.listChanges()) {
    if (change.type !== 'DELETE' && change.content) {
      files[change.path] = change.content.toString('utf8');
    }
  }
  return files;
}

export interface Diff {
  created: Files;
  updated: Files;
}

/** Runs `action` and reports the files it created and the ones it changed. */
export async function diffOf(
  tree: Tree,
  action: () => Promise<void>,
): Promise<Diff> {
  const before = filesOf(tree);
  await action();
  const after = filesOf(tree);
  const diff: Diff = { created: {}, updated: {} };
  for (const [path, content] of Object.entries(after)) {
    if (!(path in before)) diff.created[path] = content;
    else if (before[path] !== content) diff.updated[path] = content;
  }
  return diff;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller states the shape of the JSON file.
export function parseJson<T = Record<string, unknown>>(
  text: string | undefined,
): T {
  if (text === undefined) throw new Error('file was not generated');
  return JSON.parse(text) as T;
}

/** Fails when Prettier would change a generated file, so `prettier --check .` stays green. */
export async function expectFormatted(files: Files): Promise<void> {
  const options = { singleQuote: true, endOfLine: 'lf' } as const;
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(?:ts|mts|mjs|json)$/.test(path)) continue;
    expect(await format(content, { ...options, filepath: path }), path).toBe(
      content,
    );
  }
}
