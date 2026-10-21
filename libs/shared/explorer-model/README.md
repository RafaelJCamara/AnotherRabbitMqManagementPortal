# explorer-model

The plain logic of the explorer UI (M0-54): the data port, the inventory model, the window source over `inventory.query` and `explorer.window`, and the saved-view definition. It has no Angular, no DOM, no Node API and no `rxjs`, so the Node perf harness and the testkit can run the same window source the web app runs.

Tags: `type:pure`, `runtime:isomorphic`.

## Status

Slices A to C of M0-54: the data port, the inventory model (kinds, columns, facets, caps), the window source (windows, the version pin and following the rows on screen), the key budget and the fake data port. The saved-view definition (slice F) is in.

## Public API

- **Ports** (`ports.ts`): `ExplorerData` (`query(input, signal)` over `inventory.query`; `follow(params, listener)` over `explorer.window`, returning the unsubscribe), `ExplorerLiveEvent` (`snapshot`, `delta`, `gap`, `status`, `reset`, `error`, `end`), the row and answer types of the contracts, and the plain window shapes (`WindowRequest`, `WindowAnswer`, `RowChange`) that `ui-grid`'s `EngineWindowSource` accepts; `feature-explorer` has a compile-time guard that they stay assignable.
- **Inventory model** (`inventory-model.ts`): `EXPLORER_KINDS`, `COLUMNS_BY_KIND` (the engine's column names, default visibility, sortable), `FACETS_BY_KIND` and `sanitizeFilter` (only the facets that apply to a kind are ever sent), `FILTER_CAPS`, `FILTER_DEBOUNCE_MS`, `WINDOW_BLOCK` (200) and `SUB_KEYS_MAX` (500).
- **`createInventoryWindowSource(data, {cid, kind, filter})`** (`window-source.ts`): one source is one query. `window()` sends one `inventory.query` per block (offset a multiple of 200, at most 200 rows, one sort column, the answer's `matched` as the total) and refuses anything else before sending; the first answer of a scroll pins its version and later blocks send it; a new sort or `refreshed()` ends the pin; an answer that says the pinned version is gone asks the grid for one reload (a `refresh` change). `watch(ids)` follows exactly the ids the grid reports: nothing is sent for the same set or a subset, a different set is an `unsub` and a `sub` with the keys in screen order (at most 500 keys and `SUB_KEYS_BYTES_MAX` of key text, the rest counted as unfollowed); topic items become `upsert` changes with the key put back, the version marker is never a row, a snapshot is reconciled (a followed key it lacks is a `remove`), a marker newer than the pin is one `refresh` per version, a `reset` clears the pin and asks one reload, and an ended topic is shown (`live: ended`, `liveProblem`) while windows keep working. `state()` and `onState()` carry the last freshness, the matched count, the pin, the live state and counters.
- **View definition** (`view-definition.ts`): `parseViewDefinition(raw, kind)` never throws and returns the definition that applies plus every drop (`newer-version`, `wrong-kind`, `filter-not-for-kind`, `unknown-column`, `filter-over-cap`, `invalid`); `serializeView` refuses a definition over the contract's 16,384 characters.
- **Key budget** (`key-budget.ts`): `fitKeys` and `SUB_KEYS_BYTES_MAX` (48 KiB): the hub closes the whole connection on a client frame over 64 KiB, and a real key can be 682 characters.
- **Testing** (`@app/explorer-model/testing`): `createFakeExplorerData` (N rows per kind, a two-version history, one controllable topic, failures and held answers); not the engine.

## Invariants

- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint explorer-model` enforces them.
- Bounded (I-6): a window is at most 200 rows, a subscription follows at most 500 keys and 48 KiB of key text; every row left out is counted.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p explorer-model
```