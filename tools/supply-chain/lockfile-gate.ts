// Lockfile gate (DC-24): every package must come from the registry with an integrity hash.
// No git, tarball URL, directory or file dependencies, because they carry no provenance.
import {
  dedupe,
  LockfileParseError,
  parseLockfile,
  violation,
} from './shared.ts';
import type { Violation, Workspace } from './shared.ts';

export const LOCKFILE_RULES = [
  'lockfile.unparseable',
  'lockfile.exotic-source',
  'lockfile.missing-integrity',
] as const;

const EXOTIC_SPECIFIER =
  /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:)/;

export function checkLockfile(ws: Workspace): Violation[] {
  let lock;
  try {
    lock = parseLockfile(ws.lockfileText);
  } catch (error) {
    const message =
      error instanceof LockfileParseError ? error.message : String(error);
    return [
      violation(
        'lockfile',
        'lockfile.unparseable',
        'pnpm-lock.yaml',
        `The lockfile cannot be read: ${message}`,
      ),
    ];
  }

  const out: Violation[] = [];
  for (const pkg of lock.packages) {
    const resolution = pkg.resolution;
    const exotic =
      'tarball' in resolution ||
      'repo' in resolution ||
      'commit' in resolution ||
      ('type' in resolution && resolution['type'] !== 'registry') ||
      'directory' in resolution ||
      /[:/]/.test(pkg.version);
    if (exotic) {
      out.push(
        violation(
          'lockfile',
          'lockfile.exotic-source',
          pkg.key,
          `${pkg.name} resolves from a git, tarball or directory source instead of the registry (DC-24).`,
        ),
      );
    } else if (
      typeof resolution['integrity'] !== 'string' ||
      resolution['integrity'] === ''
    ) {
      out.push(
        violation(
          'lockfile',
          'lockfile.missing-integrity',
          pkg.key,
          `${pkg.name}@${pkg.version} has no integrity hash.`,
        ),
      );
    }
  }
  for (const dep of lock.importerVersions) {
    if (EXOTIC_SPECIFIER.test(dep.version)) {
      out.push(
        violation(
          'lockfile',
          'lockfile.exotic-source',
          `${dep.name}@${dep.version}`,
          `${dep.importer} depends on ${dep.name} from a non-registry source (DC-24).`,
        ),
      );
    }
  }
  return dedupe(out);
}
