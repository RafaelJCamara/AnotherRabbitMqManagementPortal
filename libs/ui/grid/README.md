# ui-grid

The grid adapter (M0-53, DC-52): AG Grid Community behind a contract features use without seeing AG Grid. It reads 100k rows through engine windows (block 200, at most 25 blocks resident) and owns the context menu, clipboard, column chooser and status bar that AG Grid keeps in its commercial tier.

Tags: `type:ui-lib`, `runtime:browser`. `ag-grid-community` may be imported only here (I-11), and only by `grid-config.ts`, `data-grid.component.ts` and the specs; no AG Grid type or value crosses the public API.

## Status

Slices A to E of M0-53: the window contract, the windowed datasource and the fake window source (A); columns, column state and selection logic (B); `<app-data-grid>` with the explicit Community module list, the theme bridge and the bundle check (C); the context menu and the key chords (D); the clipboard, the column chooser and the status bar (E). `apps/perf` and `perf:grid-100k` (AC-1, AC-4, AC-16) wait for the `perf` project; nothing here has been measured in a real browser yet (the partial S-14 record, `docs/architecture/s-14-ag-grid-infinite-100k.md`, says what was and was not verified).

## Public API

- **`<app-data-grid>`** (`DataGrid`, `data-grid.component.ts`): inputs `columns`, `source` (a new object is a new query), `selectionMode` (`none`, `single`, `multiple`), `sortMode` (`multi` by default; `single` keeps one sort column: a second one is dropped, the first kept, and the output `sortTrimmed` says so), `labels`; models `selection` (a set of row ids) and `columnState`; signals `stats`, `total`, `error`; `retry()`. It calls `createGrid` itself (no `ag-grid-angular`, OQ-541), registers an explicit list of Community modules (`GRID_MODULE_NAMES`), turns the AG Grid and the browser context menus off, loads no font, and passes the style nonce (`GRID_STYLE_NONCE`: the app's token, else Angular's `CSP_NONCE`, else the `csp-nonce` meta tag) so the grid runs under `style-src 'self' 'nonce-N'`.
- **Theme bridge** (`grid-config.ts`): the design tokens in force (`ThemeService`) become AG Grid theme parameters and the row height of the density token; they are pushed again, in one turn, when `ThemeService.revision` changes.
- **Context menu** (`context-menu.ts`): input `contextMenu` is a `GridMenuProvider` (a cell target in, `GridMenuItem[]` out: `plain`, `gated` with the engine's `GateDecision`, `separator`); output `menuAction` carries the item id and the cell. The menu is ours (WAI-ARIA menu pattern: `role=menu`, `menuitem`, focus on the first live item, arrows, Home, End, Escape returns focus to the cell, Tab or a click elsewhere closes it); AG Grid's menu is off and the browser's is prevented. A gate is open only for `enabled: true`; any other gate (missing, `null`, wrong type) is closed: `aria-disabled`, still focusable, the reason and source shown as text, nothing emitted.
- **Key chords** (`keybindings.ts`): input `keybindings` (`GridKeybinding`: id, `GridChord`, `run(GridKeyContext)`) replaces the defaults, `DEFAULT_GRID_KEYBINDINGS` (copy with Ctrl or Cmd+C; open the menu with Shift+F10 or the context-menu key); `matchesChord` matches a chord exactly. Space toggles the focused row's selection.
- **Clipboard** (`clipboard.ts`): Ctrl or Cmd+C copies the selected rows that are loaded as tab-separated text of the displayed (formatted, masked) values of the visible columns, in the order on screen, no header row; a cell with a tab, a line break or a quote is quoted. At most `GRID_MAX_COPY_ROWS` (5,000); rows past the cap or not loaded are counted (`copyTruncated`, the status bar says `copied/not copied`); a clipboard that refuses is an error in the status bar. The text goes through `GRID_CLIPBOARD` (default `navigator.clipboard`: a secure context and a user gesture).
- **Column chooser** (`column-chooser.ts`): a button opens a panel with, per column, a show or hide box, Up and Down buttons, a width and a Reset; at least one column stays visible; every change is a new `GridColumnState`.
- **Status bar** (`status-bar.ts`): total (an unknown total says unknown, never 0), rows loaded, rows selected, a block loading or failed (with Try again), the last copy, the selection cap and dropped live changes, in a polite live region.
- **`GridLabels`**: every word the grid shows, already translated (`gridLabel`, `loading`, `noRows`, `menu`: the menu's name and the words around a closed gate's reason, `status`, `columnChooser`; `{count}`, `{omitted}` and `{name}` mark where a value goes). AG Grid reads its locale text once, at creation; a later change of `labels` updates only the accessible name.
- **Window contract** (`window-source.ts`): `GRID_BLOCK_SIZE` (200), `GRID_MAX_BLOCKS` (25), `EngineWindowSource<Row>` (`rowId`, `window(request, signal)`, optional `watch`, `onChanges` and `refreshed`; a change is an `upsert`, a `remove` or a `refresh`), `GridWindowRequest`, `GridWindow`, `GridRowChange`, `GridSort`.
- **`WindowedDatasource<Row>`** (`windowed-datasource.ts`): `getRows(blockRequest)` loads one block (aligned to 200, at most `maxConcurrent` in flight, a bounded wait queue); `retry()`; `setVisibleIds(ids)` (debounced 100 ms to `watch`); `destroy()` (aborts what is in flight; a late answer is dropped and counted). Signals `stats`, `total` (`null` means unknown, never 0) and `error`. `mapSortModel` maps AG Grid's sort model to `GridSort[]`. Live changes: shown ids are applied once per 100 ms, other ids are dropped and counted, a `remove` refreshes the cache at most once every 5 s, and so does a `refresh` change, which names no row, is never dropped as "not shown" and is not counted in `changesDropped`. Whenever the cache reloads (a refresh, a removal or `retry()`) the source's `refreshed()` is called first, so a source that pins a version can start a new scroll (M0-54, Q-4). A block that rejects, or answers with more rows than its limit, fails as a whole.
- **Columns** (`columns.ts`): `GridColumn<Row>` (function `value` only), `resolveColumns` (fails closed with `GridColumnError` on a string expression, a duplicate or an empty id), `cellText` (the displayed, formatted text of a cell). Cells are text: the grid has no cell renderer and builds no element from a value.
- **Column state** (`column-state.ts`): `GridColumnState` (plain, versioned JSON), `normalizeColumnState` (ignores unknown and duplicate ids, clamps widths, keeps one column visible), `hideColumn`, `showColumn`, `resizeColumn`, `moveColumn`, `defaultColumnState`. The component applies a state from outside once and publishes the one the user makes (order, width, visibility, pinning, sort).
- **Selection** (`selection.ts`): `selectRow` over a set of row ids (survives block eviction), capped at `GRID_MAX_SELECTION` (5,000). The set is ours; AG Grid only shows it on the rows that are loaded (`aria-selected`).
- **Testing** (`@app/ui-grid/testing`): `createFakeWindowSource` (N rows, latency, failures, oversized answers, unknown total, late answers, a change feed) and `provideGridRenderAll` (a test DOM has no layout, so AG Grid renders every row; never provide it in an app).

## Invariants

- Bounded (I-6, I-7): 200-row blocks, 25 blocks, two requests in flight, a capped wait queue, a selection cap, pending live changes keyed by visible id. The UI never holds a list-all.
- No silent loss (I-13): failed blocks, stale answers, dropped changes and refreshes are counters in `stats`.
- No `innerHTML`, no string expressions (no `new Function`, ADR-021), no font or other fetch, no AG Grid Enterprise (DC-50).
- Dependencies follow the type:ui-lib row of blueprint 2.2; `pnpm nx lint ui-grid` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-grid   # test runs test-components (the component specs) first
pnpm nx run ui-grid:bundle-check                     # AC-3: no Enterprise module; the shipped-artefact gates on the bundle
pnpm nx test grid-bundle-check                       # the same check as a test, and the scan on planted Enterprise paths
```
