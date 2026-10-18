// `nx run semantics:audit-cells`: checks the semantics registry data and fails on any problem.
//   node --import ./tools/semantics-audit/register.mjs tools/semantics-audit/audit-cells.ts \
//     [--require=citations,conformance,effect] [--data=<module exporting registryData>] [--root=<dir>]
// It only reads: it never changes a cell, a status or an evidence file (I-14). Lives outside
// @app/semantics because that library is isomorphic and may not touch the file system.
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Requirement } from '@app/semantics';

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const root = resolve(option('root') ?? process.cwd());
const dataPath = option('data');

const fail = (lines: readonly string[]): never => {
  for (const line of lines) console.error(`audit-cells: ${line}`);
  process.exit(1);
};

function isRequirement(
  value: string,
  allowed: readonly string[],
): value is Requirement {
  return allowed.includes(value);
}

interface Loaded {
  readonly semantics: typeof import('@app/semantics');
  readonly data: unknown;
}

async function load(): Promise<Loaded> {
  let semantics: typeof import('@app/semantics');
  try {
    semantics = await import('@app/semantics');
  } catch (error) {
    // Importing the library builds its own registry, which throws on invalid data.
    const problems =
      error instanceof Error && 'problems' in error
        ? (error.problems as readonly string[])
        : [String(error)];
    return fail(problems);
  }
  if (dataPath === undefined)
    return { semantics, data: semantics.registryData };
  const module = (await import(
    pathToFileURL(isAbsolute(dataPath) ? dataPath : join(root, dataPath)).href
  )) as { registryData?: unknown };
  if (module.registryData === undefined) {
    return fail([`${dataPath} does not export registryData`]);
  }
  return { semantics, data: module.registryData };
}

const { semantics, data } = await load();

const required = (option('require') ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');
const unknown = required.filter(
  (name) => !isRequirement(name, semantics.REQUIREMENTS),
);
if (unknown.length > 0) {
  fail([
    `unknown requirement ${unknown.join(', ')}; use ${semantics.REQUIREMENTS.join(', ')}`,
  ]);
}

const problems = new Set(semantics.validateRegistryData(data));
const parsed = semantics.RegistryDataSchema.safeParse(data);
if (parsed.success) {
  const findings = semantics.auditCells(parsed.data.cells, {
    require: required.filter((name): name is Requirement =>
      isRequirement(name, semantics.REQUIREMENTS),
    ),
    evidenceExists: (path) => existsSync(join(root, path)),
  });
  for (const finding of findings) {
    problems.add(`cell ${finding.cell}: ${finding.message}`);
  }
}

if (problems.size > 0) fail([...problems]);
const count = parsed.success ? parsed.data.cells.length : 0;
console.log(
  `audit-cells: ${String(count)} cell(s) pass${required.length > 0 ? ` (required: ${required.join(', ')})` : ''}.`,
);
