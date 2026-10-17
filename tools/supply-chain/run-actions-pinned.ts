// Entry point for `nx run supply-chain:actions-pinned`.
//   node tools/supply-chain/run-actions-pinned.ts
// Scans .github/workflows/*.y(a)ml and .github/actions/**/action.y(a)ml. Exits 1 on any violation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  checkActionsPinned,
  formatActionsViolations,
} from './actions-pinned.ts';
import type { WorkflowFile } from './actions-pinned.ts';

const root = resolve(import.meta.dirname, '..', '..');
const github = join(root, '.github');

function collect(dir: string, pick: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(path, pick));
    else if (pick(entry.name)) found.push(path);
  }
  return found;
}

const paths = [
  ...collect(join(github, 'workflows'), (n) => /\.ya?ml$/.test(n)),
  ...collect(join(github, 'actions'), (n) => /^action\.ya?ml$/.test(n)),
];
const files: WorkflowFile[] = paths.map((path) => ({
  path: relative(root, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

if (files.length === 0) {
  console.error('actions-pinned: no workflow files found under .github.');
  process.exit(1);
}

const violations = checkActionsPinned(files);
if (violations.length > 0) {
  console.error(
    `actions-pinned FAILED (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n${formatActionsViolations(violations)}`,
  );
  process.exit(1);
}
console.log(
  `actions-pinned passed: ${files.length} workflow and action files, every \`uses:\` pinned by full SHA.`,
);
