// Version ranges for data tables such as the hazard list ("affects >=4.3.0 <4.3.6"). A small,
// closed grammar, parsed strictly, so a typo in a data file fails at build time instead of
// silently matching nothing:
//
//   range      := set ( "||" set )*
//   set        := "*" | comparator ( " " comparator )*
//   comparator := ( "<" | "<=" | ">" | ">=" | "=" )? partial
//   partial    := N | N.N | N.N.N[-pre] | N.x | N.N.x      ("x" may also be "*")
//
// A bare partial is an x-range ("4.3" means >=4.3.0 <4.4.0). Unlike npm ranges there is no special
// rule for pre-releases: they take part by plain precedence, so "<4.3.6" includes 4.3.6-rc.1.
// That errs towards reporting a hazard, which is the safe direction.
import { z } from 'zod';
import { compareSemVer, parseSemVer, type SemVer } from './semver.ts';

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  readonly op: Operator;
  readonly version: SemVer;
}

export interface VersionRange {
  /** The text this range was parsed from, trimmed. */
  readonly raw: string;
  /** Alternatives (`||`), each a conjunction of comparators. Empty conjunction: any version. */
  readonly sets: readonly (readonly Comparator[])[];
}

const PARTIAL =
  /^(?:(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Za-z.-]+))?)$/;
const WILDCARD = /^[x*]$/;

const core = (major: number, minor: number, patch: number): SemVer => ({
  major,
  minor,
  patch,
  raw: `${String(major)}.${String(minor)}.${String(patch)}`,
});

interface Parts {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly pre: string | undefined;
}

function parsePartial(text: string): Parts | null {
  const match = PARTIAL.exec(text);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((part) => {
    if (part === undefined || WILDCARD.test(part)) return null;
    return Number(part);
  });
  // A wildcard (or a missing part) ends the version: "4.x.3" is malformed.
  const [major = null, minor = null, patch = null] = parts;
  if (
    (major === null && minor !== null) ||
    (minor === null && patch !== null)
  ) {
    return null;
  }
  if (parts.some((part) => part !== null && !Number.isSafeInteger(part))) {
    return null;
  }
  if (match[4] !== undefined && patch === null) return null;
  return { major, minor, patch, pre: match[4] };
}

/** The comparators one `op partial` term stands for. */
function expand(op: Operator, partial: Parts): Comparator[] | null {
  const { major, minor, patch, pre } = partial;
  if (major === null) {
    // "*": any version, but a bound on "any" is meaningless.
    return op === '=' ? [] : null;
  }
  const lowest = core(major, minor ?? 0, patch ?? 0);
  if (patch !== null) {
    const exact = parseSemVer(
      `${String(major)}.${String(minor ?? 0)}.${String(patch)}${pre === undefined ? '' : `-${pre}`}`,
    );
    return exact === null ? null : [{ op, version: exact }];
  }
  // Missing minor or patch: the term stands for a whole minor or major line.
  const next =
    minor === null ? core(major + 1, 0, 0) : core(major, minor + 1, 0);
  switch (op) {
    case '=':
      return [
        { op: '>=', version: lowest },
        { op: '<', version: next },
      ];
    case '>=':
      return [{ op: '>=', version: lowest }];
    case '>':
      return [{ op: '>=', version: next }];
    case '<':
      return [{ op: '<', version: lowest }];
    case '<=':
      return [{ op: '<', version: next }];
  }
}

const OPERATOR = /^(<=|>=|<|>|=)?(.+)$/;

function parseSet(text: string): Comparator[] | null {
  const terms = text.split(/\s+/).filter((term) => term !== '');
  if (terms.length === 0) return null;
  const comparators: Comparator[] = [];
  for (const term of terms) {
    const match = OPERATOR.exec(term);
    const body = match?.[2];
    if (match === null || body === undefined) return null;
    const partial = parsePartial(body.replace(/^v/, ''));
    if (partial === null) return null;
    const expanded = expand((match[1] as Operator | undefined) ?? '=', partial);
    if (expanded === null) return null;
    comparators.push(...expanded);
  }
  return comparators;
}

/** Parses a range; null when the text is not in the grammar above. */
export function parseVersionRange(text: string): VersionRange | null {
  const raw = text.trim();
  if (raw === '') return null;
  const sets: Comparator[][] = [];
  for (const alternative of raw.split('||')) {
    const set = parseSet(alternative);
    if (set === null) return null;
    sets.push(set);
  }
  return { raw, sets };
}

function holds({ op, version }: Comparator, candidate: SemVer): boolean {
  const order = compareSemVer(candidate, version);
  switch (op) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '=':
      return order === 0;
  }
}

/** True when `candidate` lies inside `range`. */
export function rangeIncludes(range: VersionRange, candidate: SemVer): boolean {
  return range.sets.some((set) =>
    set.every((comparator) => holds(comparator, candidate)),
  );
}

/** A zod string that must be a valid range, for data tables. */
export const VersionRangeTextSchema = z
  .string()
  .refine((text) => parseVersionRange(text) !== null, {
    message: 'not a valid version range (for example ">=4.3.0 <4.3.6")',
  });
export type VersionRangeText = z.infer<typeof VersionRangeTextSchema>;
