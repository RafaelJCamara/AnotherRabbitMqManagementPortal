import { GRID_BLOCK_SIZE, GRID_MAX_BLOCKS } from './window-source';

export type GridSelectionMode = 'none' | 'single' | 'multiple';

/** The selection is a set of row ids, so it survives block eviction. It is bounded (I-6, I-7). */
export const GRID_MAX_SELECTION = GRID_BLOCK_SIZE * GRID_MAX_BLOCKS;

export interface SelectionChange {
  readonly selection: ReadonlySet<string>;
  /** True when the cap stopped an addition; the status bar says so (I-13). */
  readonly refused: boolean;
}

/**
 * A click on a row. `additive` (Ctrl or Cmd) toggles in multiple mode and clears in single mode.
 * Rows leaving the cache never reach this function, so eviction cannot change the set.
 */
export function selectRow(
  current: ReadonlySet<string>,
  mode: GridSelectionMode,
  rowId: string,
  additive: boolean,
): SelectionChange {
  if (mode === 'none') return { selection: current, refused: false };
  if (mode === 'single' || !additive) {
    const same = current.size === 1 && current.has(rowId);
    return {
      selection: same && additive ? new Set() : new Set([rowId]),
      refused: false,
    };
  }
  if (current.has(rowId)) {
    const next = new Set(current);
    next.delete(rowId);
    return { selection: next, refused: false };
  }
  if (current.size >= GRID_MAX_SELECTION)
    return { selection: current, refused: true };
  return { selection: new Set(current).add(rowId), refused: false };
}
