// Entry point for `nx run work-graph:validate`.
//   node tools/work-graph/run-validate.ts [--root=<dir>] [--exceptions=<file>]
// Reads docs/product/features.md, docs/plan/work-items.json and docs/plan/work-items.md under the
// root (default: this repository) and exits 1 on any violation that is not a known exception.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyExceptions, parseExceptions } from './exceptions.ts';
import { formatViolations, validateGraph } from './validate.ts';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const repoRoot = resolve(import.meta.dirname, '..', '..');
const customRoot = option('root');
const root = customRoot === undefined ? repoRoot : resolve(customRoot);
const exceptionsPath =
  option('exceptions') ??
  (customRoot === undefined
    ? join(import.meta.dirname, 'known-exceptions.json')
    : undefined);

function read(relative: string): string {
  const path = join(root, relative);
  if (!existsSync(path)) {
    console.error(`work-graph: ${relative} not found under ${root}.`);
    process.exit(1);
  }
  return readFileSync(path, 'utf8');
}

const { violations, summary } = validateGraph({
  featuresMd: read('docs/product/features.md'),
  workItemsJson: read('docs/plan/work-items.json'),
  workItemsMd: read('docs/plan/work-items.md'),
});

let failing = violations;
let known: ReturnType<typeof applyExceptions>['known'] = [];
if (exceptionsPath !== undefined) {
  const parsed = parseExceptions(readFileSync(exceptionsPath, 'utf8'));
  const questions =
    parsed.exceptions.length > 0
      ? new Set(
          [...read('docs/open-questions.md').matchAll(/^\| (OQ-\d+) \|/gm)].map(
            (m) => m[1] ?? '',
          ),
        )
      : new Set<string>();
  const applied = applyExceptions(violations, parsed.exceptions, questions);
  failing = [...parsed.violations, ...applied.failing];
  known = applied.known;
}

if (known.length > 0) {
  console.log(
    `work-graph: ${String(known.length)} known finding${known.length === 1 ? '' : 's'} tracked as open questions:`,
  );
  for (const { violation, exception } of known) {
    console.log(
      `  [${violation.rule}] ${violation.subject} (${exception.oq}): ${violation.message}`,
    );
  }
}
if (failing.length > 0) {
  console.error(
    `work-graph FAILED (${String(failing.length)} violation${failing.length === 1 ? '' : 's'}):\n${formatViolations(failing)}`,
  );
  process.exit(1);
}
console.log(
  `work-graph passed: ${String(summary.items)} work items (${String(summary.dependencies)} dependencies) and ${String(summary.features)} features (${String(summary.featureDependencies)} dependencies) checked; ${String(known.length)} known finding${known.length === 1 ? '' : 's'} tracked as open questions.`,
);
