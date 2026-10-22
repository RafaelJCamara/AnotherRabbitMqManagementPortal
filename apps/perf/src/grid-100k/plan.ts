// The fixed sequence of AC-4: seeded random jumps over all 100k rows, with a sort click every so often. A fixed
// seed makes the figures compare run to run; the oracle says which row names must be on screen after each step
// (checked by content in the page, so a screen that merely changed does not count).
import { nameAt, ROWS } from './shared';

export type SortDirection = 'asc' | 'desc' | 'none';

export type Step =
  | { readonly kind: 'jump'; readonly index: number }
  | { readonly kind: 'sort'; readonly to: SortDirection };

/** Mulberry32: a small seeded generator (no dependency); the same seed gives the same sequence everywhere. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The sort a header click leads to, in AG Grid's cycle: none, ascending, descending, none. */
export function nextSort(current: SortDirection): SortDirection {
  if (current === 'none') return 'asc';
  return current === 'asc' ? 'desc' : 'none';
}

/** The name the row at `index` shows when the grid is sorted `direction` (the fake source sorts by position). */
export function nameAtRow(index: number, direction: SortDirection): string {
  return nameAt(direction === 'desc' ? ROWS - 1 - index : index);
}

export interface PlanOptions {
  readonly jumps: number;
  readonly seed: number;
  /** Rows that fit the viewport, so the last jump can still show a full screen. */
  readonly visibleRows: number;
  /** A sort click comes before jump number k of every n (k = n/2: mid-period), so the last n/2 + 1 jumps follow no sort and the cache is full again (0: never). */
  readonly sortEvery: number;
}

/** `jumps` jumps to random first rows in [0, ROWS - visibleRows], and a sort click before every `sortEvery`-th one. */
export function planJumps(options: PlanOptions): Step[] {
  const next = seeded(options.seed);
  const span = ROWS - options.visibleRows + 1;
  const steps: Step[] = [];
  let sort: SortDirection = 'none';
  for (let n = 1; n <= options.jumps; n++) {
    if (
      options.sortEvery > 0 &&
      n % options.sortEvery === options.sortEvery / 2
    ) {
      sort = nextSort(sort);
      steps.push({ kind: 'sort', to: sort });
    }
    steps.push({ kind: 'jump', index: Math.floor(next() * span) });
  }
  return steps;
}
