// A field-level diff of two JSON values (AC-2): every leaf that differs, with its path, so a failed
// three-way test says which field moved (`steps[3].result.redelivered`), not just that something did.
import type { Json } from '../record/evidence.ts';

export interface FieldDiff {
  readonly path: string;
  /** The value on the left (the recorded evidence, or the registry). `undefined` when it has no such field. */
  readonly expected: Json | undefined;
  /** The value on the right (the live run, or the evidence). */
  readonly actual: Json | undefined;
}

/** More than this many differences is reported as the first ones plus a count. */
export const MAX_DIFFS = 40;

const isObject = (value: Json | undefined): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function diffJson(
  expected: Json | undefined,
  actual: Json | undefined,
  path = '$',
): FieldDiff[] {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: FieldDiff[] = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
      out.push(...diffJson(expected[i], actual[i], `${path}[${String(i)}]`));
    }
    return out;
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
    ].sort();
    return keys.flatMap((key) =>
      diffJson(expected[key], actual[key], `${path}.${key}`),
    );
  }
  return expected === actual ? [] : [{ path, expected, actual }];
}

const show = (value: Json | undefined): string =>
  value === undefined ? '(absent)' : JSON.stringify(value);

/** One line per difference, the first MAX_DIFFS of them. */
export function formatDiffs(
  diffs: readonly FieldDiff[],
  labels: { expected: string; actual: string },
): string {
  const lines = diffs
    .slice(0, MAX_DIFFS)
    .map(
      (diff) =>
        `  ${diff.path}: ${labels.expected} ${show(diff.expected)}, ${labels.actual} ${show(diff.actual)}`,
    );
  if (diffs.length > MAX_DIFFS) {
    lines.push(`  ... and ${String(diffs.length - MAX_DIFFS)} more`);
  }
  return lines.join('\n');
}
