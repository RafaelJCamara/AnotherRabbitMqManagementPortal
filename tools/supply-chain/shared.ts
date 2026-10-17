// Shared types and loaders for the supply-chain gates (M0-02, ADR-027).
// Pure TypeScript with erasable syntax only, so Node 24 runs it directly (type stripping).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

export type GateName = 'licence' | 'lockfile' | 'pin' | 'allowlist';

export interface Violation {
  gate: GateName;
  /** Stable rule id, for example `ban.primeng`. The self-test asserts on these. */
  rule: string;
  /** What is wrong, for example `primeng@22.0.1`. */
  subject: string;
  message: string;
}

export interface Licence {
  name: string;
  version: string;
  /** SPDX expression as declared by the package, or `Unknown`. */
  license: string;
  /** Only meaningful for shipped artefacts: CC-BY-4.0 is allowed for assets, never for code. */
  kind?: 'code' | 'asset';
}

export interface LockPackage {
  name: string;
  version: string;
  /** Raw lockfile key, for example `@scope/name@1.2.3`. */
  key: string;
  resolution: Record<string, unknown>;
  /** `os` or `cpu` restricted packages are only installed on matching platforms. */
  platformRestricted: boolean;
  /** Reachable only through optional dependencies, so it may not be installed on this platform. */
  optionalOnly: boolean;
  /** True for the pnpm bootstrap document, which is not part of the project graph. */
  bootstrap: boolean;
}

export interface Lockfile {
  packages: LockPackage[];
  /** Direct dependency specifiers resolved by importers: `version` strings. */
  importerVersions: { importer: string; name: string; version: string }[];
}

export interface Manifest {
  path: string;
  json: Record<string, unknown>;
}

export interface Workspace {
  label: string;
  /** Parsed pnpm-workspace.yaml. */
  settings: Record<string, unknown>;
  lockfileText: string;
  manifests: Manifest[];
  /** Parsed deps-allowlist.json. */
  allowlist: Record<string, unknown>;
  /** Text of docs/adr/ADR-027-log.md. */
  exclusionLog: string;
}

export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/** Splits `@scope/name@1.2.3` (or a git/tarball key) at the first `@` after position 0. */
export function splitKey(key: string): { name: string; version: string } {
  const at = key.indexOf('@', 1);
  return at === -1
    ? { name: key, version: '' }
    : { name: key.slice(0, at), version: key.slice(at + 1) };
}

export class LockfileParseError extends Error {}

export function parseLockfile(text: string): Lockfile {
  const docs = parseAllDocuments(text);
  const packages: LockPackage[] = [];
  const importerVersions: Lockfile['importerVersions'] = [];
  if (docs.length === 0) throw new LockfileParseError('lockfile is empty');
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new LockfileParseError(doc.errors[0]?.message ?? 'invalid YAML');
    }
    const root = asRecord(doc.toJS());
    const importers = asRecord(root['importers']);
    const rootImporter = asRecord(importers['.']);
    const bootstrap =
      'packageManagerDependencies' in rootImporter &&
      !('dependencies' in rootImporter) &&
      !('devDependencies' in rootImporter);
    for (const [importer, importerValue] of Object.entries(importers)) {
      for (const section of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
      ]) {
        for (const [name, dep] of Object.entries(
          asRecord(asRecord(importerValue)[section]),
        )) {
          const version = asRecord(dep)['version'];
          if (typeof version === 'string')
            importerVersions.push({ importer, name, version });
        }
      }
    }
    // A package is optional-only when every one of its snapshots is marked optional.
    const snapshotOptional = new Map<string, boolean>();
    for (const [snapshotKey, snapshot] of Object.entries(
      asRecord(root['snapshots']),
    )) {
      const key = snapshotKey.split('(')[0] ?? snapshotKey;
      const optional = asRecord(snapshot)['optional'] === true;
      snapshotOptional.set(
        key,
        (snapshotOptional.get(key) ?? true) && optional,
      );
    }
    for (const [key, value] of Object.entries(asRecord(root['packages']))) {
      const entry = asRecord(value);
      const { name, version } = splitKey(key);
      packages.push({
        name,
        version,
        key,
        resolution: asRecord(entry['resolution']),
        platformRestricted: 'os' in entry || 'cpu' in entry,
        optionalOnly: snapshotOptional.get(key) ?? false,
        bootstrap,
      });
    }
  }
  if (packages.length === 0)
    throw new LockfileParseError('lockfile has no packages section');
  return { packages, importerVersions };
}

/** Returns undefined when the lockfile cannot be parsed; the lockfile gate reports that. */
export function tryParseLockfile(ws: Workspace): Lockfile | undefined {
  try {
    return parseLockfile(ws.lockfileText);
  } catch {
    return undefined;
  }
}

/** Every catalog entry (default and named) as name -> version specifier. */
export function catalogEntries(
  settings: Record<string, unknown>,
): { catalog: string; name: string; spec: string }[] {
  const out: { catalog: string; name: string; spec: string }[] = [];
  for (const [name, spec] of Object.entries(asRecord(settings['catalog']))) {
    out.push({ catalog: 'default', name, spec: String(spec) });
  }
  for (const [catalog, entries] of Object.entries(
    asRecord(settings['catalogs']),
  )) {
    for (const [name, spec] of Object.entries(asRecord(entries))) {
      out.push({ catalog, name, spec: String(spec) });
    }
  }
  return out;
}

const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactVersion(spec: string): boolean {
  return EXACT_VERSION.test(spec);
}

/** Compares `x.y.z` numerically; prerelease and build metadata are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  const pb = b.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function major(version: string): number {
  return Number.parseInt(version, 10);
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export interface WorkspaceFiles {
  settings: string;
  lockfile: string;
  manifests: string[];
  allowlist: string;
  exclusionLog: string;
}

export function loadWorkspaceFiles(
  label: string,
  files: WorkspaceFiles,
  displayRoot: string,
): Workspace {
  return {
    label,
    settings: asRecord(parse(readText(files.settings))),
    lockfileText: readText(files.lockfile),
    manifests: files.manifests.map((path) => ({
      path: relative(displayRoot, path).split(sep).join('/'),
      json: asRecord(JSON.parse(readText(path))),
    })),
    allowlist: asRecord(JSON.parse(readText(files.allowlist))),
    exclusionLog: readText(files.exclusionLog),
  };
}

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'tmp',
  'out-tsc',
  'coverage',
  '.nx',
  '.angular',
  'fixtures',
]);

function findManifests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        findManifests(join(dir, entry.name), found);
    } else if (entry.name === 'package.json') {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** The real repository: pnpm-workspace.yaml, pnpm-lock.yaml, every package.json, the allow-list and the log. */
export function loadRealWorkspace(root: string): Workspace {
  return loadWorkspaceFiles(
    'repository',
    {
      settings: join(root, 'pnpm-workspace.yaml'),
      lockfile: join(root, 'pnpm-lock.yaml'),
      manifests: findManifests(root),
      allowlist: join(root, 'tools', 'supply-chain', 'deps-allowlist.json'),
      exclusionLog: join(root, 'docs', 'adr', 'ADR-027-log.md'),
    },
    root,
  );
}

/**
 * A planted fixture: `fixtures/clean` provides every file, and the violation directory overlays
 * the files it wants to break (same file names).
 */
export function fixtureFile(
  cleanDir: string,
  overlayDir: string | undefined,
  name: string,
): string {
  if (overlayDir !== undefined && existsSync(join(overlayDir, name)))
    return join(overlayDir, name);
  return join(cleanDir, name);
}

export function loadFixtureWorkspace(
  cleanDir: string,
  overlayDir: string | undefined,
): Workspace {
  const pick = (name: string): string =>
    fixtureFile(cleanDir, overlayDir, name);
  return loadWorkspaceFiles(
    overlayDir ?? cleanDir,
    {
      settings: pick('workspace.yaml'),
      lockfile: pick('lockfile.yaml'),
      manifests: [pick('manifest.json')],
      allowlist: pick('deps-allowlist.json'),
      exclusionLog: pick('exclusion-log.md'),
    },
    cleanDir,
  );
}

export function readJsonList<T>(path: string): T[] {
  return JSON.parse(readText(path)) as T[];
}

export function violation(
  gate: GateName,
  rule: string,
  subject: string,
  message: string,
): Violation {
  return { gate, rule, subject, message };
}

export function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const id = `${v.rule}\u0000${v.subject}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
