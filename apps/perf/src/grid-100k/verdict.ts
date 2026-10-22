// The judgement of the three browser tests (M0-53 AC-1, AC-4, AC-16), kept apart from the browser so that every way
// of failing is unit-tested. Failures are of two kinds. DETERMINISTIC ones (a block over 200 rows, a misaligned
// request, more than 25 blocks resident, a CSP or Trusted Types report, a scroll that did not traverse 25 blocks,
// a dead detector) fail at once and are never retried. TIMING / MEMORY ones (frames per second, a long task, the
// heap ratio) depend on how loaded the machine is, so a run may repeat up to MAX_ATTEMPTS times and passes when one
// attempt meets the budgets; every attempt is printed, and a regression that is real fails all of them.
import type { LongTask } from './page';
import type { PageState, PolicyState } from './shared';

/** The budgets of the spec (docs/specs/M0-53.md; the thresholds are Q-4 of that spec). */
export const BUDGETS = {
  /** AC-1: frames per second while scrolling. */
  fps: 55,
  /** AC-1: no main-thread task longer than this. */
  longTaskMs: 50,
  /** AC-4: retained heap after the last jump, over the heap at the middle of the run (a comparable cache). */
  heapRatio: 1.15,
} as const;

export interface Verdict {
  readonly deterministic: readonly string[];
  readonly timing: readonly string[];
}

export type AttemptOutcome = 'passed' | 'failed' | 'retry';

/** What to do after an attempt: stop green, stop red, or try again (timing and memory failures only). */
export function nextStep(
  verdict: Verdict,
  attempt: number,
  maxAttempts: number,
): AttemptOutcome {
  if (verdict.deterministic.length > 0) return 'failed';
  if (verdict.timing.length === 0) return 'passed';
  return attempt < maxAttempts ? 'retry' : 'failed';
}

/** Frames per second over the frames the recorder saw: (n - 1) intervals between the first and the last. */
export function framesPerSecond(stamps: readonly number[]): number {
  const first = stamps[0];
  const last = stamps.at(-1);
  if (first === undefined || last === undefined || last <= first) return 0;
  return ((stamps.length - 1) / (last - first)) * 1000;
}

/** The longest gap between two frames, in ms. */
export function longestFrameGap(stamps: readonly number[]): number {
  let longest = 0;
  for (let i = 1; i < stamps.length; i++) {
    longest = Math.max(longest, (stamps[i] ?? 0) - (stamps[i - 1] ?? 0));
  }
  return longest;
}

export interface ScrollData {
  /** One `requestAnimationFrame` timestamp per frame while the wheel input ran. */
  readonly stamps: readonly number[];
  /** Long tasks that began while it ran. */
  readonly longTasks: readonly LongTask[];
  /** The page's counts at the end, and the block starts asked for before and after the scroll. */
  readonly state: PageState;
  readonly distinctBlocksBefore: number;
  /** Where the viewport started and ended, in pixels. */
  readonly scrollFrom: number;
  readonly scrollTo: number;
  readonly rowHeight: number;
  /** Frames the recorder must have seen for the figure to mean anything. */
  readonly minFrames: number;
}

/** AC-1. */
export function judgeScroll(data: ScrollData): Verdict {
  const deterministic: string[] = [];
  const timing: string[] = [];
  const blocks = data.state.distinctBlocks - data.distinctBlocksBefore;
  if (blocks <= data.state.blockLimit) {
    deterministic.push(
      `the scroll asked for ${String(blocks)} distinct blocks, not more than the ${String(data.state.blockLimit)} the grid keeps: it did not traverse enough rows`,
    );
  }
  if (data.state.maxLimit > data.state.blockSize) {
    deterministic.push(
      `a request asked for ${String(data.state.maxLimit)} rows, more than a block of ${String(data.state.blockSize)}`,
    );
  }
  if (data.state.misaligned > 0) {
    deterministic.push(
      `${String(data.state.misaligned)} request(s) did not start on a multiple of ${String(data.state.blockSize)}`,
    );
  }
  if (data.stamps.length < data.minFrames) {
    deterministic.push(
      `the frame recorder saw ${String(data.stamps.length)} frames, fewer than ${String(data.minFrames)}: the fps figure would mean nothing`,
    );
  }
  const rows = (data.scrollTo - data.scrollFrom) / data.rowHeight;
  if (!(rows > data.state.blockLimit * data.state.blockSize)) {
    deterministic.push(
      `the viewport moved ${rows.toFixed(0)} rows, not more than ${String(data.state.blockLimit * data.state.blockSize)}`,
    );
  }
  const fps = framesPerSecond(data.stamps);
  if (!(fps >= BUDGETS.fps)) {
    timing.push(
      `${fps.toFixed(1)} fps is not at least ${String(BUDGETS.fps)} (longest gap between frames ${longestFrameGap(data.stamps).toFixed(0)} ms)`,
    );
  }
  const long = data.longTasks.filter(
    (task) => task.duration > BUDGETS.longTaskMs,
  );
  if (long.length > 0) {
    timing.push(
      `${String(long.length)} main-thread task(s) above ${String(BUDGETS.longTaskMs)} ms (longest ${Math.max(...long.map((t) => t.duration)).toFixed(0)} ms)`,
    );
  }
  return { deterministic, timing };
}

export interface MemoryData {
  /**
   * The JS heap after a forced collection at three points: after the first five windows (the spec's literal
   * baseline, printed), at the middle of the run and after the last jump (the two that are compared).
   */
  readonly firstFiveBytes: number;
  readonly midBytes: number;
  readonly finalBytes: number;
  /** Blocks resident at the middle and at the end: a comparison of heaps is fair only at a comparable cache. */
  readonly blocksAtMid: number;
  readonly blocksAtFinal: number;
  /** Jumps done in all, and jumps planned. */
  readonly jumps: number;
  readonly planned: number;
  readonly state: PageState;
}

/** A cache with at least this many blocks resident counts as "full" for the comparison (the limit is 25). */
export const COMPARABLE_BLOCKS = 15;

/**
 * AC-4. The heap is compared where the cache holds a comparable number of blocks (the middle and the end of the
 * run), because the cache itself is allowed to grow to 25 blocks and the heap after the first five windows holds
 * about a third of that (docs/open-questions.md, M0-53 perf rows): what must be flat is what the jumps leave
 * behind, not what the cache is allowed to fill.
 */
export function judgeMemory(data: MemoryData): Verdict {
  const deterministic: string[] = [];
  const timing: string[] = [];
  if (data.jumps !== data.planned) {
    deterministic.push(
      `${String(data.jumps)} jumps were made, ${String(data.planned)} were planned`,
    );
  }
  if (data.state.maxBlocks > data.state.blockLimit) {
    deterministic.push(
      `the grid held ${String(data.state.maxBlocks)} blocks at once, more than ${String(data.state.blockLimit)}`,
    );
  }
  if (data.state.maxLimit > data.state.blockSize) {
    deterministic.push(
      `a request asked for ${String(data.state.maxLimit)} rows, more than a block of ${String(data.state.blockSize)}`,
    );
  }
  if (data.state.misaligned > 0) {
    deterministic.push(
      `${String(data.state.misaligned)} request(s) did not start on a multiple of ${String(data.state.blockSize)}`,
    );
  }
  if (data.state.requests < data.planned) {
    deterministic.push(
      `only ${String(data.state.requests)} requests reached the source for ${String(data.planned)} jumps: the grid was not reading through it`,
    );
  }
  if (
    data.blocksAtMid < COMPARABLE_BLOCKS ||
    data.blocksAtFinal < COMPARABLE_BLOCKS
  ) {
    deterministic.push(
      `the cache held ${String(data.blocksAtMid)} blocks at the middle and ${String(data.blocksAtFinal)} at the end, fewer than ${String(COMPARABLE_BLOCKS)}: the two heaps are not comparable`,
    );
  }
  if (
    !(data.firstFiveBytes > 0) ||
    !(data.midBytes > 0) ||
    !(data.finalBytes > 0)
  ) {
    deterministic.push('a heap size was not read');
  } else if (data.finalBytes > data.midBytes * BUDGETS.heapRatio) {
    timing.push(
      `the heap after the last jump is ${(data.finalBytes / data.midBytes).toFixed(3)} times the heap at the middle of the run (${String(data.finalBytes)} over ${String(data.midBytes)} bytes), above ${String(BUDGETS.heapRatio)}`,
    );
  }
  return { deterministic, timing };
}

/** The literal figure of the spec's AC-4 (heap after all jumps over the heap after the first five windows). */
export function literalRatio(data: MemoryData): number {
  return data.finalBytes / data.firstFiveBytes;
}
export interface PolicyData {
  /** The Content-Security-Policy values the server sent. */
  readonly policies: readonly string[];
  /** Every CSP / Trusted Types report from every channel, boot included. */
  readonly violations: readonly string[];
  readonly before: PolicyState;
  readonly after: PolicyState;
  /** The app menu while open: its items, and which one held focus. */
  readonly menu: { items: number; focusedIndex: number } | null;
  readonly menuClosedByEscape: boolean;
  readonly scrolled: boolean;
}

/** AC-16. Everything here is deterministic: a policy is either kept or not. */
export function judgePolicy(data: PolicyData): Verdict {
  const deterministic: string[] = [];
  for (const violation of data.violations) {
    deterministic.push(`CSP / Trusted Types report: ${violation}`);
  }
  if (data.policies.length === 0) {
    deterministic.push('the server sent no Content-Security-Policy');
  }
  for (const policy of new Set(data.policies)) {
    for (const required of [
      "require-trusted-types-for 'script'",
      "style-src 'self' 'nonce-",
      "script-src 'self'",
    ]) {
      if (!policy.includes(required)) {
        deterministic.push(`the policy sent lacks ${required}`);
      }
    }
    if (policy.includes('unsafe-eval')) {
      deterministic.push("the policy sent allows 'unsafe-eval'");
    }
  }
  if (data.before.nonce === '') {
    deterministic.push('the page has no csp-nonce meta: styleNonce is not set');
  }
  if (data.after.styleElements === 0) {
    deterministic.push(
      'the page holds no <style> element: AG Grid injected none, so the nonce was not exercised',
    );
  }
  if (data.after.noncedStyleElements !== data.after.styleElements) {
    deterministic.push(
      `${String(data.after.styleElements - data.after.noncedStyleElements)} of ${String(data.after.styleElements)} <style> elements carry no nonce`,
    );
  }
  if (!data.scrolled) deterministic.push('the grid did not scroll');
  if (data.menu === null) {
    deterministic.push('the right click opened no role="menu"');
  } else {
    if (data.menu.items < 1) deterministic.push('the menu has no menuitem');
    if (data.menu.focusedIndex !== 0) {
      deterministic.push(
        `focus is on menu item ${String(data.menu.focusedIndex)}, not the first`,
      );
    }
  }
  if (!data.menuClosedByEscape)
    deterministic.push('Escape did not close the menu');
  if (data.before.theme === data.after.theme) {
    deterministic.push(
      `the theme did not change (${String(data.after.theme)})`,
    );
  }
  if (data.before.gridBackground === data.after.gridBackground) {
    deterministic.push(
      `the grid background did not follow the theme change (${data.after.gridBackground})`,
    );
  }
  if (data.before.rowHeight === data.after.rowHeight) {
    deterministic.push(
      `the row height did not follow the density change (${String(data.after.rowHeight)} px)`,
    );
  }
  for (const [when, state] of [
    ['before', data.before],
    ['after', data.after],
  ] as const) {
    if (state.gridRootStyleAttribute !== null) {
      deterministic.push(
        `the grid root has an inline style attribute ${when} the theme change: ${state.gridRootStyleAttribute}`,
      );
    }
  }
  return { deterministic, timing: [] };
}
