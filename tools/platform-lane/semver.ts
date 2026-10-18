// A small, dependency-free subset of semver (M0-76). It is enough to read the `engines.node` and
// `peerDependencies` ranges that npm packages publish: comparators (`>= < <= > =`), caret, tilde,
// x-ranges, hyphen ranges, `||` and space-separated AND. Only stable versions are tested (the lane
// never proposes a pre-release), so pre-release tags are accepted in ranges but otherwise ignored.

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Parses `x.y.z` (a leading `v` is allowed). Returns null for anything else, including pre-releases. */
export function parseVersion(text: string): Version | null {
  const match = STABLE.exec(text.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

type Operator = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  operator: Operator;
  version: Version;
}

const WILDCARD = /^[xX*]$/;
const PARTIAL =
  /^v?(?<major>\d+|[xX*])(?:\.(?<minor>\d+|[xX*]))?(?:\.(?<patch>\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
}

function parsePartial(text: string): Partial | null {
  const match = PARTIAL.exec(text);
  if (match?.groups === undefined) return null;
  const part = (value: string | undefined): number | null =>
    value === undefined || WILDCARD.test(value) ? null : Number(value);
  const major = part(match.groups.major);
  const minor = major === null ? null : part(match.groups.minor);
  const patch = minor === null ? null : part(match.groups.patch);
  return { major, minor, patch };
}

function v(major: number, minor: number, patch: number): Version {
  return { major, minor, patch };
}

function cmp(operator: Operator, version: Version): Comparator {
  return { operator, version };
}

const ANY: Comparator[] = [cmp('>=', v(0, 0, 0))];

/** The comparators a bare partial such as `1.2` or `1.x` means: `>=1.2.0 <1.3.0`. */
function fromPartial(p: Partial): Comparator[] {
  if (p.major === null) return ANY;
  if (p.minor === null)
    return [cmp('>=', v(p.major, 0, 0)), cmp('<', v(p.major + 1, 0, 0))];
  if (p.patch === null)
    return [
      cmp('>=', v(p.major, p.minor, 0)),
      cmp('<', v(p.major, p.minor + 1, 0)),
    ];
  return [cmp('=', v(p.major, p.minor, p.patch))];
}

function caret(p: Partial): Comparator[] {
  if (p.major === null) return ANY;
  const { major, minor, patch } = p;
  const lower = v(major, minor ?? 0, patch ?? 0);
  let upper: Version;
  if (major > 0) upper = v(major + 1, 0, 0);
  else if (minor === null) upper = v(1, 0, 0);
  else if (minor > 0) upper = v(0, minor + 1, 0);
  else if (patch === null) upper = v(0, 1, 0);
  else upper = v(0, 0, patch + 1);
  return [cmp('>=', lower), cmp('<', upper)];
}

function tilde(p: Partial): Comparator[] {
  if (p.major === null) return ANY;
  const lower = v(p.major, p.minor ?? 0, p.patch ?? 0);
  const upper =
    p.minor === null ? v(p.major + 1, 0, 0) : v(p.major, p.minor + 1, 0);
  return [cmp('>=', lower), cmp('<', upper)];
}

function relational(operator: Operator, p: Partial): Comparator[] {
  if (p.major === null) return operator === '<' ? [cmp('<', v(0, 0, 0))] : ANY;
  const { major, minor, patch } = p;
  const full = v(major, minor ?? 0, patch ?? 0);
  if (minor === null || patch === null) {
    // A partial bound rounds to the edge of the range it names.
    const next = minor === null ? v(major + 1, 0, 0) : v(major, minor + 1, 0);
    if (operator === '>') return [cmp('>=', next)];
    if (operator === '<=') return [cmp('<', next)];
  }
  return [cmp(operator, full)];
}

const TOKEN = /^(?<op>\^|~>?|>=|<=|>|<|=)?(?<rest>.*)$/;

function parseToken(token: string): Comparator[] | null {
  const match = TOKEN.exec(token);
  const rest = match?.groups?.rest ?? '';
  const op = match?.groups?.op ?? '';
  const partial =
    rest === ''
      ? { major: null, minor: null, patch: null }
      : parsePartial(rest);
  if (partial === null) return null;
  switch (op) {
    case '^':
      return caret(partial);
    case '~':
    case '~>':
      return tilde(partial);
    case '>=':
    case '<=':
    case '>':
    case '<':
      return relational(op, partial);
    case '=':
    case '':
      return fromPartial(partial);
    default:
      return null;
  }
}

function parseComparatorSet(set: string): Comparator[] | null {
  // `1.2.3 - 2.3.4` means `>=1.2.3 <=2.3.4`.
  let text = set
    .trim()
    .replace(
      /^(\S+)\s+-\s+(\S+)$/,
      (_all, low: string, high: string) => `>=${low} <=${high}`,
    );
  // `>= 1.2.3` is `>=1.2.3`.
  text = text.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
  const comparators: Comparator[] = [];
  for (const token of text.split(/\s+/).filter((t) => t !== '')) {
    const parsed = parseToken(token);
    if (parsed === null) return null;
    comparators.push(...parsed);
  }
  return comparators.length === 0 ? ANY : comparators;
}

function holds(
  version: Version,
  { operator, version: bound }: Comparator,
): boolean {
  const order = compareVersions(version, bound);
  switch (operator) {
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

/**
 * True when `version` satisfies `range`. Returns null when the range is not understood, so a
 * caller can report "unknown" instead of guessing.
 */
export function satisfies(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (parsed === null) return null;
  const alternatives = range.split('||').map(parseComparatorSet);
  if (alternatives.some((set) => set === null)) return null;
  return alternatives.some((set) =>
    (set ?? []).every((comparator) => holds(parsed, comparator)),
  );
}
