// Producer for the shipped-artefact licence gate (M0-73, amendment A-19).
// Turns an esbuild metafile (apps/engine `meta.json`, Angular `browser-stats.json`; the
// electron-builder file list joins from M2) into the list of third-party packages that end up in a
// release artefact. The shipped gate (`checkShippedLicences`) then enforces DC-50 exactly on it.
//
// Conservative on purpose: every `node_modules` input in the metafile counts, even when tree
// shaking dropped most of it, and every external import of the bundle counts, because the artefact
// must be installed next to those packages.
import { builtinModules } from 'node:module';
import { asRecord, violation } from './shared.ts';
import type { Licence, Violation } from './shared.ts';

export const BUNDLED_RULES = [
  'licence.shipped-input',
  'licence.shipped-unresolved',
] as const;

/** Reads the `package.json` of a package directory (relative to the repository root), if present. */
export type PackageJsonReader = (
  dir: string,
) => Record<string, unknown> | undefined;

export interface BundledPackages {
  packages: Licence[];
  /** Metafile or package problems, as `licence.shipped-input` / `licence.shipped-unresolved`. */
  problems: Violation[];
}

const NODE_MODULES = 'node_modules/';
const BUILTINS = new Set(builtinModules);

/** `license`, `{ type }` or the legacy `licenses` array, as one SPDX expression. `Unknown` when absent. */
export function declaredLicence(pkg: Record<string, unknown>): string {
  const field = pkg['license'];
  if (typeof field === 'string' && field.trim() !== '') return field.trim();
  const type = asRecord(field)['type'];
  if (typeof type === 'string' && type.trim() !== '') return type.trim();
  const legacy = pkg['licenses'];
  if (Array.isArray(legacy)) {
    const types = legacy
      .map((entry) => asRecord(entry)['type'])
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    if (types.length > 0) return types.join(' OR ');
  }
  return 'Unknown';
}

/** `node_modules/.pnpm/x@1/node_modules/@scope/name/dist/a.js` -> `node_modules/.pnpm/x@1/node_modules/@scope/name`. */
export function packageDirOfInput(inputPath: string): string | undefined {
  const path = inputPath.replace(/\\/g, '/');
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return undefined;
  const rest = path.slice(at + NODE_MODULES.length).split('/');
  const nameParts = rest[0]?.startsWith('@') ? 2 : 1;
  const name = rest.slice(0, nameParts).join('/');
  if (name === '' || (nameParts === 2 && rest.length < 2)) return undefined;
  return path.slice(0, at + NODE_MODULES.length) + name;
}

/** `@scope/name/sub/path` -> `@scope/name`; undefined for relative paths and Node built-ins. */
export function packageNameOfSpecifier(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  )
    return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0];
  if (name === undefined || name === '' || BUILTINS.has(name)) return undefined;
  return name;
}

/**
 * The bundled third-party packages of one esbuild metafile. `label` names the artefact in
 * violation subjects, for example `engine` or `web`.
 */
export function packagesFromMetafile(
  label: string,
  metafile: unknown,
  read: PackageJsonReader,
): BundledPackages {
  const problems: Violation[] = [];
  const meta = asRecord(metafile);
  const inputs = asRecord(meta['inputs']);
  const outputs = asRecord(meta['outputs']);
  if (Object.keys(inputs).length === 0 || Object.keys(outputs).length === 0) {
    return {
      packages: [],
      problems: [
        violation(
          'licence',
          'licence.shipped-input',
          label,
          `${label}: not an esbuild metafile (needs non-empty "inputs" and "outputs"), so the shipped licence gate has nothing to check.`,
        ),
      ],
    };
  }

  const dirs = new Set<string>();
  for (const input of Object.keys(inputs)) {
    const dir = packageDirOfInput(input);
    if (dir !== undefined) dirs.add(dir);
  }
  for (const output of Object.values(outputs)) {
    const imports = asRecord(output)['imports'];
    for (const imp of Array.isArray(imports) ? imports : []) {
      const entry = asRecord(imp);
      if (entry['external'] !== true || typeof entry['path'] !== 'string')
        continue;
      const name = packageNameOfSpecifier(entry['path']);
      if (name !== undefined) dirs.add(`${NODE_MODULES}${name}`);
    }
  }

  const packages = new Map<string, Licence>();
  for (const dir of [...dirs].sort()) {
    const pkg = read(dir);
    const name = pkg?.['name'];
    const version = pkg?.['version'];
    if (
      pkg === undefined ||
      typeof name !== 'string' ||
      typeof version !== 'string'
    ) {
      problems.push(
        violation(
          'licence',
          'licence.shipped-unresolved',
          `${label}: ${dir}`,
          `${label}: bundled package at ${dir} has no readable package.json with a name and version, so its licence cannot be checked.`,
        ),
      );
      continue;
    }
    packages.set(`${name}@${version}`, {
      name,
      version,
      license: declaredLicence(pkg),
      kind: 'code',
    });
  }
  return {
    packages: [...packages.values()],
    problems,
  };
}
