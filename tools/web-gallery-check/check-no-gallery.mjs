// Proves the dev-only gallery is not in a production build (M0-50, AC-2).
//
//   node apps/web/scripts/check-no-gallery.mjs <production-dir> <development-dir>
//
// The production output must hold no trace of the gallery: no file named after it and no file
// whose text carries one of its markers. The development output is the control: it must hold
// them, so a scan that cannot see the gallery (a renamed selector, a different output layout)
// fails instead of passing on an empty result.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Strings only the gallery contains: its selector and its title. */
export const MARKERS = ['app-dev-gallery', 'Design system gallery'];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** The files of `dir` that are named after the gallery or contain a marker. */
export function galleryTraces(dir) {
  const traces = [];
  for (const path of files(dir)) {
    if (/gallery/i.test(path.slice(dir.length))) {
      traces.push(`${path} (file name)`);
      continue;
    }
    const text = readFileSync(path, 'latin1');
    const marker = MARKERS.find((candidate) => text.includes(candidate));
    if (marker !== undefined) traces.push(`${path} (${marker})`);
  }
  return traces;
}

/** Returns the problems found; an empty list means the check passed. */
export function check(productionDir, developmentDir) {
  const problems = [];
  const production = galleryTraces(productionDir);
  if (production.length > 0) {
    problems.push(
      `The production build contains the gallery:\n  ${production.join('\n  ')}`,
    );
  }
  if (galleryTraces(developmentDir).length === 0) {
    problems.push(
      `The development build has no gallery, so this check cannot see it: ${developmentDir}`,
    );
  }
  if (files(productionDir).next().done === true) {
    problems.push(`The production build is empty: ${productionDir}`);
  }
  return problems;
}

if (import.meta.main) {
  const [productionDir, developmentDir] = process.argv.slice(2);
  if (!productionDir || !developmentDir) {
    console.error(
      'usage: check-no-gallery.mjs <production-dir> <development-dir>',
    );
    process.exit(2);
  }
  const problems = check(productionDir, developmentDir);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('gallery-absent: ok');
}
