// Edits of the policy tables in eslint.config.mjs. The file keeps its policy as plain data
// (`confinement`, `projectRules`), so a generator adds a table row and nothing else.
import { logger } from '@nx/devkit';

import { quote } from './names.ts';
import { appendToArray, arrayOfObjects } from './source-edit.ts';
import type { Writer } from './writer.ts';

const CONFIG = 'eslint.config.mjs';
const ALLOWLIST = 'tools/supply-chain/deps-allowlist.json';

const PACKAGE_NAME =
  /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*\*?$/;

export function assertPackageName(value: string): void {
  if (!PACKAGE_NAME.test(value)) {
    throw new Error(
      `"${value}" is not an npm package name (a trailing * means "any package starting with this prefix").`,
    );
  }
}

/** Packages that blueprint 2.4 already confines, with the locations that may import them. */
export function confinedPackages(writer: Writer): Map<string, string[]> {
  const text = writer.require(
    CONFIG,
    'Run the generator from the workspace root.',
  );
  const confined = new Map<string, string[]>();
  for (const entry of arrayOfObjects(text, CONFIG, 'confinement')) {
    for (const name of entry.names ?? []) {
      confined.set(name, entry.only ?? []);
    }
  }
  return confined;
}

/**
 * Confines `packages` to `location` (blueprint 2.4): adds one row to the `confinement` table, so
 * the baseline rule rejects the import everywhere and the zone for `location` allows it. A package
 * that already has a row is not widened here; that is a policy change for a human to make.
 */
export function addConfinement(
  writer: Writer,
  packages: readonly string[],
  location: string,
): void {
  if (packages.length === 0) return;
  for (const name of packages) assertPackageName(name);

  const existing = confinedPackages(writer);
  for (const name of packages) {
    const only = existing.get(name);
    if (only) {
      throw new Error(
        `${name} is already confined to ${only.join(', ')}. Widening a confinement row is a policy change: edit the table in ${CONFIG} by hand and get it reviewed.`,
      );
    }
  }

  warnWhenNotAllowlisted(writer, packages);

  const text = writer.require(
    CONFIG,
    'Run the generator from the workspace root.',
  );
  const row = `{ names: [${packages.map(quote).join(', ')}], only: [${quote(location)}] }`;
  writer.write(CONFIG, appendToArray(text, CONFIG, 'confinement', row));
}

function warnWhenNotAllowlisted(
  writer: Writer,
  packages: readonly string[],
): void {
  const text = writer.read(ALLOWLIST);
  if (text === null) return;
  const listed = (JSON.parse(text) as { packages?: Record<string, unknown> })
    .packages;
  for (const name of packages) {
    if (name.endsWith('*') || (listed && name in listed)) continue;
    logger.warn(
      `${name} is not in ${ALLOWLIST}. The confinement row is in place, but the package cannot be installed until the allow-list, the catalog and the release-age gate accept it (security lane, ADR-027).`,
    );
  }
}

/** Adds an entry to the `projectRules` table (rules from tools/eslint-rules, M0-04). */
export function addProjectRule(
  writer: Writer,
  rule: { id: string; invariant: string; directories: readonly string[] },
): void {
  const text = writer.require(
    CONFIG,
    'Run the generator from the workspace root.',
  );
  const files = `tsIn(${rule.directories.map(quote).join(', ')})`;
  const comment = rule.invariant
    .split('\n')
    .map((line) => `// ${line}`)
    .join('\n    ');
  const entry = `{
    ${comment}
    name: ${quote(`app/${rule.id}`)},
    files: ${files},
    plugins: appPlugin,
    rules: { ${quote(`@app/${rule.id}`)}: 'error' },
  }`;
  writer.write(CONFIG, appendToArray(text, CONFIG, 'projectRules', entry));
}
