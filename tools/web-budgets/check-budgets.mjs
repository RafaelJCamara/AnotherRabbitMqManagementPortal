// Bundle budgets for the web app, measured on the gzip size of a production build (M0-51, AC-3).
//
//   node tools/web-budgets/check-budgets.mjs <browser-dir>
//
// "Initial" is everything `index.html` references: scripts, modulepreloads and stylesheets. Their
// gzip sizes are summed and compared with INITIAL_LIMIT. Every other script or stylesheet in the
// output is a lazy chunk, and each one is compared with LAZY_LIMIT. A scan that sees nothing
// proves nothing, so an output without an `index.html`, without a referenced script, or with a
// reference to a missing file fails instead of passing on an empty sum.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

/** 1 kB is 1 000 bytes, the stricter reading (M0-51 spec, question 10). */
export const INITIAL_LIMIT = 350_000;
/** One lazy chunk (feature limit of `.claude/rules/ui.md`). */
export const LAZY_LIMIT = 200_000;
/** The zlib default, close to what a static file server sends. */
export const GZIP_LEVEL = 6;

const MEASURED = /\.(?:m?js|css)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** The key of a file inside `dir`: a forward-slash path relative to it. */
function key(dir, path) {
  return relative(dir, path).split(sep).join('/');
}

function gzipSize(path) {
  return gzipSync(readFileSync(path), { level: GZIP_LEVEL }).length;
}

/** Local files that `index.html` loads (scripts, modulepreloads, stylesheets), as keys. */
export function initialReferences(html) {
  const found = new Set();
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const kind = match[1].toLowerCase();
    const attributes = match[2];
    if (
      kind === 'link' &&
      !/\brel\s*=\s*["']?(?:modulepreload|stylesheet)\b/i.test(attributes)
    ) {
      continue;
    }
    const reference = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(attributes);
    if (reference === null) continue;
    const url = reference[1].split(/[?#]/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue; // not served from this origin
    found.add(posix.normalize(url.replace(/^\//, '')));
  }
  return [...found];
}

/**
 * Measures `dir` (the `browser` folder of a production build).
 * Returns `{ problems, initial, lazy }`; an empty `problems` list means the budgets hold.
 */
export function measure(
  dir,
  { initialLimit = INITIAL_LIMIT, lazyLimit = LAZY_LIMIT } = {},
) {
  const problems = [];
  const initial = { files: [], total: 0, limit: initialLimit };
  const lazy = [];
  const indexPath = join(dir, 'index.html');
  if (!existsSync(dir) || !existsSync(indexPath)) {
    problems.push(`No index.html in ${dir}: nothing to measure.`);
    return { problems, initial, lazy };
  }
  const references = initialReferences(readFileSync(indexPath, 'utf8'));
  if (!references.some((reference) => reference.endsWith('.js'))) {
    problems.push(
      `index.html references no script, so the initial bundle cannot be measured.`,
    );
    return { problems, initial, lazy };
  }
  for (const reference of references) {
    const path = join(dir, reference);
    if (!existsSync(path)) {
      problems.push(
        `index.html references ${reference}, which is not in the output.`,
      );
      continue;
    }
    const size = gzipSize(path);
    initial.files.push({ file: reference, size });
    initial.total += size;
  }
  const initialSet = new Set(references);
  for (const path of files(dir)) {
    const name = key(dir, path);
    if (!MEASURED.test(name) || initialSet.has(name)) continue;
    lazy.push({ file: name, size: gzipSize(path) });
  }
  if (initial.total > initialLimit) {
    const list = initial.files
      .toSorted((a, b) => b.size - a.size)
      .map(({ file, size }) => `  ${file}: ${size} bytes gzip`)
      .join('\n');
    problems.push(
      `The initial bundle is ${initial.total} bytes gzip, above the limit of ${initialLimit}:\n${list}`,
    );
  }
  for (const { file, size } of lazy) {
    if (size > lazyLimit) {
      problems.push(
        `The lazy chunk ${file} is ${size} bytes gzip, above the limit of ${lazyLimit}.`,
      );
    }
  }
  return { problems, initial, lazy };
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: check-budgets.mjs <browser-dir>');
    process.exit(2);
  }
  const { problems, initial, lazy } = measure(dir);
  console.log(
    `web:budgets initial ${initial.total} / ${initial.limit} bytes gzip in ${initial.files.length} files; ${lazy.length} lazy chunks`,
  );
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('web:budgets: ok');
}
