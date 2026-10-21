# explorer-model

The plain logic of the explorer UI (M0-54): the data port, the inventory model, the window source over `inventory.query` and `explorer.window`, and the saved-view definition. It has no Angular, no DOM, no Node API and no `rxjs`, so the Node perf harness and the testkit can run the same window source the web app runs.

Tags: `type:pure`, `runtime:isomorphic`.

## Status

Slice A of M0-54: the project exists and exports nothing yet. The data port and the window source come with slices B and C, the view definition with slice F.

## Public API

- Nothing yet. List every export of `src/index.ts` here.

## Invariants

- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint explorer-model` enforces them.
- Bounded (I-6): a window is at most 200 rows, a subscription follows at most 500 keys and 48 KiB of key text; every row left out is counted.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p explorer-model
```