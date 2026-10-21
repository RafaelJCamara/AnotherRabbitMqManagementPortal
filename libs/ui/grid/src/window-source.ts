// The contract between a feature and the grid (blueprint 10, M0-53). The grid never learns how
// the engine answers; M0-54 writes the adapter from `inventory.query` / `explorer.window` to this.

/** Fixed by blueprint 10 and the issue: one block is 200 rows, at most 25 blocks stay resident. */
export const GRID_BLOCK_SIZE = 200;
export const GRID_MAX_BLOCKS = 25;

export interface GridSort {
  readonly columnId: string;
  readonly direction: 'asc' | 'desc';
}

export interface GridWindowRequest {
  readonly offset: number; // a multiple of GRID_BLOCK_SIZE
  readonly limit: number; // at most GRID_BLOCK_SIZE
  readonly sort: readonly GridSort[];
}

export interface GridWindow<Row> {
  readonly rows: readonly Row[]; // at most `limit`
  readonly total: number | null; // null: not known (the end has not been reached)
}

export type GridRowChange<Row> =
  | { readonly kind: 'upsert'; readonly row: Row }
  | { readonly kind: 'remove'; readonly rowId: string };

/** What the explorer hands the grid. */
export interface EngineWindowSource<Row> {
  readonly rowId: (row: Row) => string;
  window(
    request: GridWindowRequest,
    signal: AbortSignal,
  ): Promise<GridWindow<Row>>;
  /** Optional live feed (the `explorer.window` deltas). The grid reports the ids it shows. */
  watch?(visibleIds: ReadonlySet<string>): void;
  onChanges?(
    listener: (changes: readonly GridRowChange<Row>[]) => void,
  ): () => void;
}
