// One turn of the event loop (I-5). The yield is injected where it is used, so a spec can count the
// turns instead of timing them.
import { setImmediate as nextTurn } from 'node:timers/promises';

/** Lets the event loop run once. */
export type YieldNow = () => Promise<void>;

/** One turn of the event loop (`setImmediate`): timers, I/O and other requests get to run. */
export const nextLoopTurn: YieldNow = async () => {
  await nextTurn();
};

/** Calls `yieldNow` once per `every` calls of the returned function. */
export function ticker(every: number, yieldNow: YieldNow): () => Promise<void> {
  const step = Math.max(1, every);
  let done = 0;
  return async () => {
    done += 1;
    if (done % step === 0) await yieldNow();
  };
}

/** Takes `b[j]` only when it sorts strictly before `a[i]`, so equal items keep their order (stable). */
async function merge<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
  tick: () => Promise<void>,
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
    await tick();
  }
  return out;
}

/**
 * `[...items].sort(compare)` in pieces (I-5): runs of `every` items are sorted whole, then merged
 * pairwise, yielding every `every` items written. The result is the one a plain stable sort gives.
 */
export async function sortCooperative<T>(
  items: readonly T[],
  compare: (x: T, y: T) => number,
  every: number,
  yieldNow: YieldNow,
): Promise<T[]> {
  const step = Math.max(1, every);
  if (items.length <= step) return [...items].sort(compare);
  const tick = ticker(step, yieldNow);
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
        right === undefined ? left : await merge(left, right, compare, tick),
      );
    }
    runs = merged;
  }
  return runs[0] ?? [];
}
