// Semantic versions as the broker reports them ("4.3.6", "4.4.0-alpha.1a2b3c"). Parsing is strict
// and returns null instead of guessing: a version that cannot be parsed is an unknown build, and
// callers must treat it conservatively (blueprint 5.2).
import { z } from 'zod';

export const SemVerSchema = z.strictObject({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  /** Pre-release identifiers without the leading dash, for example `alpha.1`. */
  pre: z.string().min(1).optional(),
  /** The text this version was parsed from, trimmed. */
  raw: z.string().min(1),
});
export type SemVer = z.infer<typeof SemVerSchema>;

const IDENTIFIER = '[0-9A-Za-z-]+';
const SEMVER = new RegExp(
  `^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?` +
    `(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`,
);

/** Parses `major.minor.patch[-pre][+build]` (a leading `v` is accepted); null when malformed. */
export function parseSemVer(text: string): SemVer | null {
  const raw = text.trim();
  const match = SEMVER.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) {
    return null;
  }
  const pre = match[4];
  return pre === undefined
    ? { major, minor, patch, raw }
    : { major, minor, patch, pre, raw };
}

const NUMERIC = /^\d+$/;

/** Pre-release precedence of semver 2.0 section 11; an absent pre-release ranks highest. */
function comparePre(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split('.');
  const right = b.split('.');
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const x = left[index] ?? '';
    const y = right[index] ?? '';
    if (x === y) continue;
    const xNumeric = NUMERIC.test(x);
    const yNumeric = NUMERIC.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

/** Total order on versions: -1 when `a` ranks below `b`, 0 when equal, 1 when above. */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const pre = comparePre(a.pre, b.pre);
  return pre < 0 ? -1 : pre > 0 ? 1 : 0;
}

/** The lowest of the given versions, or null for an empty list. */
export function lowestSemVer(versions: readonly SemVer[]): SemVer | null {
  let lowest: SemVer | null = null;
  for (const version of versions) {
    if (lowest === null || compareSemVer(version, lowest) < 0) {
      lowest = version;
    }
  }
  return lowest;
}

/** `major.minor.patch` without pre-release or build parts, the form lab evidence is keyed by. */
export function formatCoreVersion(version: SemVer): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}
