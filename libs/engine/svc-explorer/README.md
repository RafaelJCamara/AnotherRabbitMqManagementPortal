# svc-explorer

Windowed inventory, overview and the explorer.window topic, served from an engine-resident bounded index.

Tags: `type:service`, `runtime:node`, `trust:critical`.

Status: work package M0-48 ([spec](../../../docs/specs/M0-48.md)), slices A and B of eight. Slice A shipped the module skeleton, the shared contract types, the `inventory.query` contract with a stub body, the ports and their fakes. Slice B ships the bounded index and the sweeper (internal, not yet read by the action). The real action body, `overview.get` and the `explorer.window` topic land in the later slices. The module is not yet registered in `coreModules`.

## Public API

- `createExplorerModule(deps)`: returns the `EngineModule` the composition root registers.
- `ExplorerModuleDeps`, `ExplorerLimits`, `DEFAULT_EXPLORER_LIMITS` (`src/deps.ts`): the ports the module needs (the scheduled `MgmtReadPort`, the cached profile read, the connection read, clock and timers) and the bounds of the index and its sweeps.
- `createInventoryQueryAction(deps)`: the `inventory.query` action. Until the index lands (slice C) it answers an empty window whose freshness is `unavailable` and `complete: false`, never an empty list that looks complete (I-13).
- `createExplorerFakeDeps({ queueCount, vhostCount, ownerId })` (`src/testing.ts`): fakes for those ports, including a scripted broker that serves N queues across vhosts through a paged `/api/queues` (page ceiling 500) and records every request, for specs, the architecture manifest and the HTTP specs.
- The contract schemas live in `@app/contracts` (`registry/explorer-types.ts`, `registry/inventory-query.ts`).

## Internals (slice B, src/internal/)

- `index.ts`: `createInventoryIndex`, the per-connection index. Bounded by rows and estimated bytes across kinds; rows past the cap are dropped in sweep order and counted (`stats.dropped`, `IndexVersion.dropped` and `truncated`). Every install is a new version; the previous one stays readable for a pinned window. `window` filters, sorts (a cached permutation per version, kind and column, at most 4 kept; the key breaks ties) and slices. `setStale` marks a version whose latest sweep did not finish (I-13).
- `sweeper.ts`: `createSweeper`, the only code that lists the broker. One sweep per connection at a time (a second `sweepNow` joins it); per vhost and kind, pages of 500 with `disable_stats` (and `enable_queue_totals` on queues), always in the `background` lane. A kind that already has a version is installed only when every kind was read; a failed, aborted or partial sweep leaves the last good version in place, marked stale, and the outcome carries a fixed-text Problem (no broker text, I-10). Cut of slice B: a fixed 60 s wait between sweeps and no idle stop; the cost-based cadence is the issue `M0-48 sweep cadence`. A first read installs each kind as it finishes, so a partial first sweep shows what is loaded and says it is incomplete.
- `rows.ts`: the service's own zod schemas for the part of each management answer it reads, and the mapping to rows; a field the broker left out or sent as null is absent from the row.

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel). This module is read-only: it is handed a `MgmtReadPort`, never a write port (I-2, I-8).
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`).
- No contract allows an unbounded input or output: a window is required, its `limit` is at most 500, filters and key lists are capped, and every output array has a maximum (I-7). The test `AC-1 explorer contracts allow no unbounded input or output` proves it.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-explorer contracts testkit arch-tests
pnpm nx test svc-explorer --testNamePattern=explorer
pnpm nx run contracts:api-docs-check
```
