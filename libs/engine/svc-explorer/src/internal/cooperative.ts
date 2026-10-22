// Work over a long list that lets the event loop run between chunks (I-5), with the same results as
// doing it in one go. The yield is injected so a spec can count the turns instead of timing them.
import { setImmediate as nextTurn } from 'node:timers/promises';

/** Lets the event loop run once. */
export type YieldNow = () => Promise<void>;

/** One turn of the event loop (`setImmediate`): timers, I/O and other requests get to run. */
export const nextLoopTurn: YieldNow = async () => {
  await nextTurn();
};

/**
 * Calls `each` on every item in order and yields after every `every` items. A throw of `each` ends
 * the walk at once, as in a plain loop.
 */
export async function forEachCooperative<T>(
  items: readonly T[],
  each: (item: T) => void,
  every: number,
  yieldNow: YieldNow,
): Promise<void> {
  const step = Math.max(1, every);
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at] as T;
    each(item);
    if ((at + 1) % step === 0 && at + 1 < items.length) await yieldNow();
  }
}

/** Takes `b[j]` only when it sorts strictly before `a[i]`, so equal items keep their order (stable). */
async function merge<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
  every: number,
  yieldNow: YieldNow,
): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    const takeRight =
      i >= a.length || (j < b.length && compare(right as T, left as T) < 0);
    out.push(takeRight ? (right as T) : (left as T));
    if (takeRight) j += 1;
    else i += 1;
    if (out.length % every === 0) await yieldNow();
  }
  return out;
}

/**
 * `[...items].sort(compare)` in pieces: runs of at most `every` items are sorted whole, then merged
 * pairwise, yielding every `every` items written. The comparator needs to be consistent; for equal
 * items the order is the input order, as `Array.prototype.sort` keeps it, so the result is the one a
 * plain sort gives. A list of at most `every` items is sorted in one go, without a yield.
 */
export async function sortCooperative<T>(
  items: readonly T[],
  compare: (x: T, y: T) => number,
  every: number,
  yieldNow: YieldNow,
): Promise<T[]> {
  const step = Math.max(1, every);
  if (items.length <= step) return [...items].sort(compare);
  let runs: T[][] = [];
  for (let at = 0; at < items.length; at += step) {
    runs.push(items.slice(at, at + step).sort(compare));
    await yieldNow();
  }
  while (runs.length > 1) {
    const merged: T[][] = [];
    for (let at = 0; at < runs.length; at += 2) {
      const [left = [], right] = runs.slice(at, at + 2);
      merged.push(
        right === undefined
          ? left
          : await merge(left, right, compare, step, yieldNow),
      );
    }
    runs = merged;
  }
  return runs[0] ?? [];
}
