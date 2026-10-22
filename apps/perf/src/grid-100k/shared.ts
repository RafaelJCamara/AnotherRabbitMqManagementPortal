// What the harness page reports. `apps/perf-grid-page/src/contract.ts` holds the page's copy of these types: a
// `runtime:node` and a `runtime:browser` project may not import each other (eslint.config.mjs), so the driver checks
// what the page says at run time instead (`rowCount` is ROWS; the block sizes are the library's own, read in the page).
// No Angular, no Node API.

/** Rows the fake engine window serves (M0-53 AC-1, AC-4: 100k rows). */
export const ROWS = 100_000;
/** What the fake engine window takes to answer a block: a local engine, not a network (see the README). */
export const ANSWER_LATENCY_MS = 15;
/** The name the fake row at `position` has (`createFakeWindowSource` in `@app/ui-grid/testing`). */
export const nameAt = (position: number): string => `queue-${String(position)}`;
/** The viewport of every run (AC-1: "a 1280x720 page"). */
export const VIEWPORT = { width: 1280, height: 720 } as const;

/** What `window.__grid.state()` answers (the page side of the counts AC-4 asserts). */
export interface PageState {
  /** The rows the fake window serves, and how long it takes to answer a block (the page's own constants). */
  readonly rows: number;
  readonly answerLatencyMs: number;
  /** The library's own `GRID_BLOCK_SIZE` and `GRID_MAX_BLOCKS`, read in the page so the budgets cannot drift from it. */
  readonly blockSize: number;
  readonly blockLimit: number;
  /** Blocks AG Grid's infinite cache holds right now. */
  readonly blocks: number;
  /** The most blocks it held at any sample since `startSampling()`. */
  readonly maxBlocks: number;
  /** Requests that reached the source (all, since the page loaded). */
  readonly requests: number;
  /** The widest `limit` and the largest number of requests in flight at one time. */
  readonly maxLimit: number;
  readonly maxInflight: number;
  /** Requests whose offset was not a multiple of the block size. */
  readonly misaligned: number;
  /** Distinct block starts asked for since the page loaded. */
  readonly distinctBlocks: number;
  /** Rows (`.ag-row`) in the DOM now, and the most at any sample. */
  readonly domRows: number;
  readonly maxDomRows: number;
  /** AG Grid's row count and the viewport's scroll position. */
  readonly rowCount: number;
  readonly scrollTop: number;
  readonly rowHeight: number;
  readonly viewportHeight: number;
}

/** What the page reports about its policy and theme (AC-16). */
export interface PolicyState {
  readonly nonce: string;
  /** `<style>` elements in the document, and how many carry the page's nonce (`element.nonce`). */
  readonly styleElements: number;
  readonly noncedStyleElements: number;
  /** Elements of the grid that carry a `style` attribute in markup (not set through the CSSOM). */
  readonly gridRootStyleAttribute: string | null;
  readonly theme: string | null;
  readonly density: string | null;
  /** The grid's computed background colour, which follows the theme. */
  readonly gridBackground: string;
  readonly rowHeight: number;
  readonly menuOpen: boolean;
}
