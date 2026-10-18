// The platform manifest (platforms.json) and the pins it points at. Pure functions over text, so
// the self-test can plant a broken manifest without touching the real repository.
import { parse } from 'yaml';
import { parseVersion } from './semver.ts';

export type PinSpec =
  | { kind: 'catalog'; name: string; fallback?: string }
  | { kind: 'nvmrc' }
  | { kind: 'package-manager'; name: string };

export interface CheckSpec {
  id: string;
  label: string;
  kind: 'engines-node' | 'peer';
  /** The npm package whose published metadata is read. */
  package: string;
  /** `target`: the candidate version (same release train); `latest`: the latest dist-tag; `pinned`: the repository pin of that package. */
  at: 'target' | 'latest' | 'pinned';
  /** For `peer`: the peer dependency whose range is read. */
  peer?: string;
  /** The platform version the range must admit. */
  subject: { platform: string; version: 'pinned' | 'target' };
  /** A failing blocking check defers the issue (no issue is opened until it passes). */
  blocking?: boolean;
}

export interface Platform {
  id: string;
  name: string;
  source: 'npm' | 'node';
  /** npm package for `source: npm`. */
  package?: string;
  pin: PinSpec;
  /** `even`: only even majors count (Node's odd majors are never LTS). */
  majors: 'all' | 'even';
  cadence: string;
  /** Days after GA by which the upgrade is due, or null when the runbook sets no window. */
  windowDays: number | null;
  /** Nx and fastify bumps need an accepted ADR first. */
  adrGated: boolean;
  renovate: { groupName: string; packages: string[] };
  checks: CheckSpec[];
}

export interface Manifest {
  platforms: Platform[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parses and validates platforms.json. Throws an Error listing every problem found. */
export function parseManifest(text: string): Manifest {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`platforms.json is not JSON: ${String(error)}`);
  }
  const platforms = record(raw).platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('platforms.json needs a non-empty "platforms" array.');
  }
  const ids = new Set<string>();
  for (const entry of platforms as unknown[]) {
    const p = record(entry);
    const id = typeof p.id === 'string' ? p.id : '';
    const where = id === '' ? '(entry without id)' : id;
    if (id === '' || !/^[a-z][a-z0-9-]*$/.test(id))
      problems.push(`${where}: id must be a lowercase slug.`);
    if (ids.has(id)) problems.push(`${where}: duplicate id.`);
    ids.add(id);
    for (const key of ['name', 'cadence'] as const) {
      if (typeof p[key] !== 'string' || p[key] === '')
        problems.push(`${where}: ${key} must be a non-empty string.`);
    }
    const source = p.source;
    if (source !== 'npm' && source !== 'node')
      problems.push(`${where}: source must be "npm" or "node".`);
    if (source === 'npm' && typeof p.package !== 'string')
      problems.push(`${where}: an npm platform needs a "package".`);
    if (p.majors !== 'all' && p.majors !== 'even')
      problems.push(`${where}: majors must be "all" or "even".`);
    const window = p.windowDays;
    if (
      window !== null &&
      !(Number.isInteger(window) && (window as number) > 0)
    )
      problems.push(`${where}: windowDays must be a positive integer or null.`);
    if (typeof p.adrGated !== 'boolean')
      problems.push(`${where}: adrGated must be a boolean.`);
    const pin = record(p.pin);
    if (
      pin.kind !== 'catalog' &&
      pin.kind !== 'nvmrc' &&
      pin.kind !== 'package-manager'
    )
      problems.push(
        `${where}: pin.kind must be catalog, nvmrc or package-manager.`,
      );
    if (
      pin.fallback !== undefined &&
      (typeof pin.fallback !== 'string' || parseVersion(pin.fallback) === null)
    )
      problems.push(`${where}: pin.fallback must be an exact x.y.z version.`);
    const renovate = record(p.renovate);
    if (
      typeof renovate.groupName !== 'string' ||
      !Array.isArray(renovate.packages) ||
      renovate.packages.length === 0
    )
      problems.push(
        `${where}: renovate needs a groupName and a packages list.`,
      );
    if (!Array.isArray(p.checks))
      problems.push(`${where}: checks must be an array.`);
  }
  const known = new Set(ids);
  const checkIds = new Set<string>();
  for (const entry of platforms as unknown[]) {
    const p = record(entry);
    const platformId = typeof p.id === 'string' ? p.id : '?';
    for (const raw of Array.isArray(p.checks) ? (p.checks as unknown[]) : []) {
      const c = record(raw);
      const id = typeof c.id === 'string' ? c.id : '(check without id)';
      const where = `${platformId}/${id}`;
      if (checkIds.has(id)) problems.push(`${where}: duplicate check id.`);
      checkIds.add(id);
      if (typeof c.label !== 'string' || c.label === '')
        problems.push(`${where}: label is required.`);
      if (c.kind !== 'engines-node' && c.kind !== 'peer')
        problems.push(`${where}: kind must be engines-node or peer.`);
      if (c.kind === 'peer' && typeof c.peer !== 'string')
        problems.push(`${where}: a peer check needs "peer".`);
      if (typeof c.package !== 'string')
        problems.push(`${where}: package is required.`);
      if (c.at !== 'target' && c.at !== 'latest' && c.at !== 'pinned')
        problems.push(`${where}: at must be target, latest or pinned.`);
      const subject = record(c.subject);
      if (typeof subject.platform !== 'string' || !known.has(subject.platform))
        problems.push(`${where}: subject.platform is not a platform id.`);
      if (subject.version !== 'pinned' && subject.version !== 'target')
        problems.push(`${where}: subject.version must be pinned or target.`);
      if (subject.version === 'target' && subject.platform !== platformId)
        problems.push(
          `${where}: only a check of the platform itself can use its target version.`,
        );
    }
  }
  if (problems.length > 0) {
    throw new Error(`platforms.json is invalid:\n  ${problems.join('\n  ')}`);
  }
  return { platforms: platforms as Platform[] };
}

/** The repository files the pins live in. */
export interface PinSources {
  /** The `catalog:` map of pnpm-workspace.yaml. */
  catalog: Record<string, string>;
  /** Content of .nvmrc. */
  nvmrc: string;
  /** The `packageManager` field of package.json, for example `pnpm@12.14.0`. */
  packageManager: string;
}

export interface Pin {
  version: string;
  /** Where it was read: `catalog`, `.nvmrc`, `packageManager` or `fallback` (not installed yet). */
  source: 'catalog' | '.nvmrc' | 'packageManager' | 'fallback';
}

export function readPinSources(
  workspaceYaml: string,
  nvmrc: string,
  packageJson: string,
): PinSources {
  const catalog = record(record(parse(workspaceYaml)).catalog);
  const strings: Record<string, string> = {};
  for (const [name, version] of Object.entries(catalog)) {
    if (typeof version === 'string') strings[name] = version;
  }
  const packageManager = record(JSON.parse(packageJson)).packageManager;
  return {
    catalog: strings,
    nvmrc,
    packageManager: typeof packageManager === 'string' ? packageManager : '',
  };
}

/** Resolves every platform's pin. Throws when a pin is missing or not an exact version. */
export function resolvePins(
  manifest: Manifest,
  sources: PinSources,
): Record<string, Pin> {
  const pins: Record<string, Pin> = {};
  const problems: string[] = [];
  for (const platform of manifest.platforms) {
    const spec = platform.pin;
    let pin: Pin | null = null;
    if (spec.kind === 'nvmrc') {
      pin = {
        version: sources.nvmrc.trim().replace(/^v/, ''),
        source: '.nvmrc',
      };
    } else if (spec.kind === 'package-manager') {
      const [name, rest] = sources.packageManager.split('@');
      if (name === spec.name && rest !== undefined)
        pin = { version: rest.split('+')[0] ?? '', source: 'packageManager' };
    } else {
      const version = sources.catalog[spec.name];
      if (version !== undefined) pin = { version, source: 'catalog' };
      else if (spec.fallback !== undefined)
        pin = { version: spec.fallback, source: 'fallback' };
    }
    if (pin === null) {
      problems.push(
        `${platform.id}: no pin found for ${JSON.stringify(spec)}.`,
      );
    } else if (parseVersion(pin.version) === null) {
      problems.push(
        `${platform.id}: pin "${pin.version}" (${pin.source}) is not an exact x.y.z version.`,
      );
    } else {
      pins[platform.id] = pin;
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return pins;
}
