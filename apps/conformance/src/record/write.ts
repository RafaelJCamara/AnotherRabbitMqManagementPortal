// The only place the recorder writes a file. It writes one artefact below an evidence root and
// refuses anything else: an artefact that does not verify, one that holds a secret, a `local`
// artefact aimed at the real evidence tree, and a path that leaves the root (also through a
// symbolic link or a junction).
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  EvidenceError,
  evidenceRelativePath,
  verifyArtefact,
  type EvidenceArtefact,
} from './evidence.ts';
import { findSecrets } from './secrets.ts';

/** The real path of `path`, or of its deepest existing ancestor with the rest appended. */
function realpathDeep(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : join(realpathDeep(parent), basename(absolute));
}

/** True when `child` is `parent` or below it (case-insensitive on Windows and macOS). */
export function isInside(parent: string, child: string): boolean {
  const fold = (text: string): string =>
    process.platform === 'linux' ? text : text.toLowerCase();
  const path = relative(fold(realpathDeep(parent)), fold(realpathDeep(child)));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export interface WriteOptions {
  /** The folder the artefact goes into: `<root>/<broker-version>/<CF-id>.json`. */
  readonly root: string;
  /** The repository's own `testing/lab-evidence`; only a `ci` artefact may be written into it. */
  readonly canonicalRoot: string;
  /** Values that must not appear in the artefact (the lab login). */
  readonly knownSecrets?: readonly string[];
}

/** Writes the artefact and returns the path of the file. Throws `EvidenceError` instead of writing. */
export function writeEvidence(
  input: EvidenceArtefact,
  options: WriteOptions,
): string {
  const artefact = verifyArtefact(input);
  const findings = findSecrets(artefact, options.knownSecrets);
  if (findings.length > 0) {
    throw new EvidenceError(
      'secret',
      `${artefact.cfId} holds ${findings.map((item) => `${item.reason} at ${item.path}`).join('; ')}`,
    );
  }
  if (
    artefact.provenance.kind !== 'ci' &&
    isInside(options.canonicalRoot, options.root)
  ) {
    throw new EvidenceError(
      'refused',
      'only the conformance-record workflow writes into testing/lab-evidence (amendment A-20)',
    );
  }
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });
  const target = join(root, evidenceRelativePath(artefact));
  mkdirSync(dirname(target), { recursive: true });
  if (!isInside(root, dirname(target))) {
    throw new EvidenceError('refused', `${target} is outside ${root}`);
  }
  // The temporary file and `rename` never write through a link at `target`: a link there is replaced.
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(artefact, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  renameSync(temporary, target);
  return target;
}
