// Policy patterns (OQ-966). The broker matches a policy's pattern with Erlang `re` (PCRE, on bytes,
// unanchored). This library has `RegExp`. It evaluates a pattern only when the pattern is in a small
// subset on which the two agree and which cannot backtrack badly, and says "uncertain" for
// everything else; it never runs a pattern it has not analysed. The subset:
//   - ASCII only, no control characters, pattern at most 512 characters, name at most 255;
//   - literals, `.`, `^`, `$`, `|`, character classes `[...]` and `[^...]` (no `[:posix:]`, no
//     leading `]`), the escapes `\d \D \w \W \s \S \b \B` and an escaped punctuation character;
//   - groups `(...)`, `(?:...)`, `(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)` (no names, no inline
//     flags, no atomic groups, no backreferences, no conditionals);
//   - quantifiers `* + ? {n} {n,} {n,m}` (counts up to 1000), each at most once per atom, optionally
//     lazy, never possessive;
//   - at most three unbounded quantifiers, and no group that contains a quantifier or an
//     alternation followed by `*`, `+` or `{`: the shapes that make a backtracking matcher
//     exponential. With at most three unbounded quantifiers and 255 characters the work is bounded.
// This is a heuristic, not a proof against every pathological pattern; the security review should
// read this file first.

export const MAX_PATTERN_LENGTH = 512;
export const MAX_NAME_LENGTH = 255;
const MAX_UNBOUNDED = 3;
const MAX_COUNT = 1000;

export type PatternResult =
  | { readonly ok: true; readonly matches: boolean }
  | { readonly ok: false; readonly reason: string };

const uncertain = (reason: string): PatternResult => ({ ok: false, reason });

function isPlain(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

const isAlnum = (char: string): boolean => /[0-9A-Za-z]/.test(char);

interface Group {
  unbounded: boolean;
  alternation: boolean;
  quantified: boolean;
}

const CLASS_ESCAPES = 'dDwWsS';
const ASSERT_ESCAPES = 'bB';

/** Why the pattern is outside the subset, or null when it is inside. */
export function patternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `longer than ${String(MAX_PATTERN_LENGTH)} characters`;
  }
  if (!isPlain(pattern)) return 'contains a non-ASCII or control character';

  const stack: Group[] = [];
  const root: Group = {
    unbounded: false,
    alternation: false,
    quantified: false,
  };
  const top = (): Group => stack[stack.length - 1] ?? root;
  let unboundedCount = 0;
  // The atom just read, so that a following quantifier knows what it applies to.
  let last: { readonly group: Group | null } | null = null;
  let index = 0;

  while (index < pattern.length) {
    const char = pattern.charAt(index);

    if (char === '\\') {
      const next = pattern.charAt(index + 1);
      if (next === '') return 'ends with a backslash';
      if (CLASS_ESCAPES.includes(next)) {
        last = { group: null };
      } else if (ASSERT_ESCAPES.includes(next)) {
        last = null;
      } else if (isAlnum(next) || next === '_') {
        return `uses the escape \\${next}`;
      } else {
        last = { group: null };
      }
      index += 2;
      continue;
    }

    if (char === '[') {
      index += 1;
      if (pattern.charAt(index) === '^') index += 1;
      if (pattern.charAt(index) === ']')
        return 'has a class that starts with ]';
      let closed = false;
      while (index < pattern.length) {
        const inner = pattern.charAt(index);
        if (inner === ']') {
          closed = true;
          index += 1;
          break;
        }
        if (inner === '[' && pattern.charAt(index + 1) === ':') {
          return 'uses a POSIX class';
        }
        if (inner === '\\') {
          const next = pattern.charAt(index + 1);
          if (next === '') return 'ends with a backslash';
          if (
            !CLASS_ESCAPES.includes(next) &&
            (isAlnum(next) || next === '_')
          ) {
            return `uses the escape \\${next} in a class`;
          }
          index += 2;
          continue;
        }
        index += 1;
      }
      if (!closed) return 'has an unclosed class';
      last = { group: null };
      continue;
    }

    if (char === '(') {
      if (pattern.charAt(index + 1) === '?') {
        const rest = pattern.slice(index + 2, index + 5);
        const allowed = [':', '=', '!', '<=', '<!'].some((prefix) =>
          rest.startsWith(prefix),
        );
        if (!allowed) return 'uses a group form outside the supported subset';
        index += 2 + (rest.startsWith('<') ? 2 : 1);
      } else {
        index += 1;
      }
      stack.push({ unbounded: false, alternation: false, quantified: false });
      last = null;
      continue;
    }

    if (char === ')') {
      const closed = stack.pop();
      if (closed === undefined) return 'has an unmatched )';
      const parent = top();
      parent.unbounded ||= closed.unbounded;
      parent.alternation ||= closed.alternation;
      parent.quantified ||= closed.quantified;
      last = { group: closed };
      index += 1;
      continue;
    }

    if (char === '|') {
      top().alternation = true;
      last = null;
      index += 1;
      continue;
    }

    if (char === '*' || char === '+' || char === '?' || char === '{') {
      if (last === null)
        return `has a quantifier ${char} with nothing to repeat`;
      let unbounded = char === '*' || char === '+';
      if (char === '{') {
        const counted = /^\{(\d{1,4})(?:(,)(\d{0,4}))?\}/.exec(
          pattern.slice(index),
        );
        if (counted === null) return 'has a { that is not a count';
        const low = Number(counted[1]);
        const high =
          counted[2] === undefined
            ? low
            : counted[3] === ''
              ? Infinity
              : Number(counted[3]);
        if (low > MAX_COUNT || (high !== Infinity && high > MAX_COUNT)) {
          return `repeats more than ${String(MAX_COUNT)} times`;
        }
        if (high < low)
          return 'has a count whose upper bound is below its lower bound';
        unbounded = high === Infinity;
        index += counted[0].length;
      } else {
        index += 1;
      }
      const group = last.group;
      const repeats = char !== '?';
      if (
        group !== null &&
        repeats &&
        (group.unbounded || group.alternation || group.quantified)
      ) {
        return 'repeats a group that already contains a quantifier or an alternation';
      }
      if (unbounded) {
        unboundedCount += 1;
        if (unboundedCount > MAX_UNBOUNDED) {
          return `has more than ${String(MAX_UNBOUNDED)} unbounded quantifiers`;
        }
        top().unbounded = true;
      }
      top().quantified = true;
      if (group !== null && repeats) group.quantified = true;
      // A lazy marker is fine; a second quantifier character (possessive or doubled) is not.
      if (pattern.charAt(index) === '?') index += 1;
      const after = pattern.charAt(index);
      if (after === '*' || after === '+' || after === '?' || after === '{') {
        return 'has a possessive or doubled quantifier';
      }
      last = null;
      continue;
    }

    // ^ $ . and every other character are atoms (or assertions); a lone ] or } is a literal.
    last = char === '^' || char === '$' ? null : { group: null };
    index += 1;
  }

  if (stack.length > 0) return 'has an unclosed group';
  return null;
}

/**
 * Whether `pattern` matches anywhere in `name`, as the broker's unanchored `re:run` would, or why
 * that cannot be answered here. A pattern outside the subset is never executed.
 */
export function testPattern(pattern: string, name: string): PatternResult {
  if (name.length > MAX_NAME_LENGTH) {
    return uncertain(
      `the name is longer than ${String(MAX_NAME_LENGTH)} characters`,
    );
  }
  if (!isPlain(name))
    return uncertain('the name contains a non-ASCII or control character');
  const problem = patternProblem(pattern);
  if (problem !== null) return uncertain(`the pattern ${problem}`);
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    return uncertain('the pattern is not a valid expression');
  }
  return { ok: true, matches: expression.test(name) };
}
