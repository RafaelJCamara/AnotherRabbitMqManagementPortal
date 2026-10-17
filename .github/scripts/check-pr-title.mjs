// Conventional Commits check for pull request titles (M0-05, CONTRIBUTING.md#conventional-commits).
// The PR title becomes the squash commit that release-please reads, so it must parse.
//   PR_TITLE='feat(engine): add probe' node .github/scripts/check-pr-title.mjs
// No dependencies, so the workflow needs no install step. Types match release-please-config.json.
import { fileURLToPath } from 'node:url';

export const TYPES = [
  'feat',
  'fix',
  'perf',
  'revert',
  'deps',
  'docs',
  'chore',
  'ci',
  'build',
  'test',
  'refactor',
  'style',
];

const HEADER = new RegExp(
  `^(?<type>${TYPES.join('|')})(?:\\((?<scope>[a-z0-9][a-z0-9._/,-]*)\\))?(?<breaking>!)?: (?<subject>\\S.*)$`,
);
const MAX_LENGTH = 100;

/** Returns an error message, or undefined when the title is a valid Conventional Commit header. */
export function checkTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    return 'The pull request title is empty.';
  }
  if (title !== title.trim() || title.includes('\n')) {
    return 'The title must be a single line without leading or trailing spaces.';
  }
  if (title.length > MAX_LENGTH) {
    return `The title is ${title.length} characters; keep it to ${MAX_LENGTH} or fewer.`;
  }
  if (!HEADER.test(title)) {
    return `"${title}" is not a Conventional Commit. Use "<type>(<optional scope>): <summary>" with a type from: ${TYPES.join(', ')}. Example: "feat(engine): add probe".`;
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const error = checkTitle(process.env['PR_TITLE'] ?? process.argv[2]);
  if (error !== undefined) {
    console.error(`pr-title FAILED: ${error}`);
    process.exit(1);
  }
  console.log('pr-title passed.');
}
