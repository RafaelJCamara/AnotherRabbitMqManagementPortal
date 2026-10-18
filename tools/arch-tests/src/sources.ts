// Reading the repository's own TypeScript sources for the architecture tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface SourceFile {
  /** Repository-relative path with forward slashes. */
  path: string;
  text: string;
}

/** The directories whose code the rules look at. */
export const SCAN_ROOTS = ['apps', 'libs', 'tools', 'testing'] as const;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  'tmp',
  '.angular',
  '.nx',
]);

// Planted violations for other self-tests; they are not part of the product.
const SKIP_PATHS = ['tools/lint-selftest/fixtures/'];

function isTypeScript(name: string): boolean {
  return /\.(?:ts|mts|cts)$/.test(name) && !name.endsWith('.d.ts');
}

/** Every TypeScript file under the scan roots of `root`, in a stable order. */
export function listSources(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const path = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (
        isTypeScript(entry.name) &&
        !SKIP_PATHS.some((skipped) => path.startsWith(skipped))
      ) {
        found.push({ path, text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const name of SCAN_ROOTS) walk(join(root, name));
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
