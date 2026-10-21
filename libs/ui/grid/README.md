# ui-grid

The grid adapter (M0-53, DC-52): AG Grid Community behind a contract features use without seeing AG Grid. It reads 100k rows through engine windows (block 200, at most 25 blocks resident) and will own the context menu, clipboard, column chooser and status bar that AG Grid keeps in its commercial tier.

Tags: `type:ui-lib`, `runtime:browser`. Imports only Angular today; `ag-grid-*` may be imported only here (I-11).

## Status

Slices A and B of M0-53, the parts that need no AG Grid: the window contract, the windowed datasource and a fake window source (A), and columns, column state and selection logic (B). The AG Grid component, the theme bridge, the Community module list, the context menu, the clipboard, the column chooser, the status bar and `bundle-check` come in later slices; the `perf:grid-100k` harness waits for the `perf` project.

## Public API

- **Window contract** (`window-source.ts`): `GRID_BLOCK_SIZE` (200), `GRID_MAX_BLOCKS` (25), `EngineWindowSource<Row>` (`rowId`, `window(request, signal)`, optional `watch` and `onChanges`), `GridWindowRequest`, `GridWindow`, `GridRowChange`, `GridSort`.
- **`WindowedDatasource<Row>`** (`windowed-datasource.ts`): `getRows(blockRequest)` loads one block (aligned to 200, at most `maxConcurrent` in flight, a bounded wait queue); `retry()`; `setVisibleIds(ids)` (debounced 100 ms to `watch`); `destroy()` (aborts what is in flight; a late answer is dropped and counted). Signals `stats`, `total` (`null` means unknown, never 0) and `error`. `mapSortModel` maps AG Grid's sort model to `GridSort[]`. Live changes: shown ids are applied once per 100 ms, other ids are dropped and counted, a `remove` refreshes the cache at most once every 5 s. A block that rejects, or answers with more rows than its limit, fails as a whole.
- **Columns** (`columns.ts`): `GridColumn<Row>` (function `value` only), `resolveColumns` (fails closed with `GridColumnError` on a string expression, a duplicate or an empty id), `cellText` (the displayed, formatted text of a cell).
- **Column state** (`column-state.ts`): `GridColumnState` (plain, versioned JSON), `normalizeColumnState` (ignores unknown and duplicate ids, clamps widths, keeps one column visible), `hideColumn`, `showColumn`, `resizeColumn`, `moveColumn`, `defaultColumnState`.
- **Selection** (`selection.ts`): `selectRow` over a set of row ids (survives block eviction), capped at `GRID_MAX_SELECTION` (5,000).
- **Testing** (`@app/ui-grid/testing`): `createFakeWindowSource` (N rows, latency, failures, oversized answers, unknown total, late answers, a change feed).

## Invariants

- Bounded (I-6, I-7): 200-row blocks, a capped wait queue, pending live changes keyed by visible id. The UI never holds a list-all.
- No silent loss (I-13): failed blocks, stale answers, dropped changes and refreshes are counters in `stats`.
- Dependencies follow the type:ui-lib row of blueprint 2.2; `pnpm nx lint ui-grid` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-grid
```
