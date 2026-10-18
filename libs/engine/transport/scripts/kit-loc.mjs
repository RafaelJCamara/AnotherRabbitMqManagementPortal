// The kit-size gate (ADR-004): the transport kit stays at or below 800 lines of code.
//
//   node libs/engine/transport/scripts/kit-loc.mjs [--dir <src dir>] [--max <n>] [--json]
//
// A line counts when it holds code: blank lines and lines that only hold a comment do not. Specs
// (`*.spec.ts`) and the test support in `src/testing/` are not part of the kit. Exit code 1 when
// the count is above the cap, so `nx run transport:kit-loc` fails the build.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX = 800;

/** Lines of code in a TypeScript source: no blank lines, no comment-only lines. */
export function countCodeLines(source) {
  let count = 0;
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    let rest = line.trim();
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      rest = rest.slice(end + 2).trim();
    }
    while (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end === -1) {
        inBlock = true;
        rest = '';
        break;
      }
      rest = rest.slice(end + 2).trim();
    }
    if (rest !== '' && !rest.startsWith('//')) count += 1;
  }
  return count;
}

/** The kit files below `dir`: every `.ts` that is not a spec and not under `testing/`. */
export function kitFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') files.push(...kitFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

export function measureKit(dir) {
  const files = kitFiles(dir).map((file) => ({
    file: relative(dir, file).replaceAll('\\', '/'),
    lines: countCodeLines(readFileSync(file, 'utf8')),
  }));
  return { files, total: files.reduce((sum, entry) => sum + entry.lines, 0) };
}

function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const dir =
    option('--dir') ??
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const max = Number(option('--max') ?? DEFAULT_MAX);
  const { files, total } = measureKit(dir);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ total, max, files }));
  } else {
    for (const { file, lines } of files)
      console.log(`${String(lines).padStart(5)}  ${file}`);
    console.log(`${String(total).padStart(5)}  total (cap ${String(max)})`);
  }
  if (!(total <= max)) {
    console.error(
      `The transport kit is ${String(total)} lines; ADR-004 caps it at ${String(max)}.`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
