# perf

Performance harnesses of the engine and its services (node only): budgets measured on synthetic data and printed for the S-13 and S-14 records.

Tags: `type:test`, `runtime:node`.

## Public API

- None: `src/index.ts` exports nothing. A harness is a file `src/<name>/<name>.perf.ts` with its own Nx target; it is run by `vitest.perf.config.mts` and never by `nx test` (a loaded machine would make a timing assertion flaky in the unit run).

## Harnesses

- `explorer-20k` (`pnpm nx run perf:explorer-20k`, M0-48 AC-24): the `inventory.query` action of `svc-explorer` over the real index and sweeper, fed by the scripted broker of `svc-explorer`'s fakes. A sweep loop keeps installing new index versions while 1,000 window queries (mixed filters, sorts, offsets and limits, a fixed random sequence) run, with `monitorEventLoopDelay` sampling every millisecond. At 20,000 queues it asserts engine time per window p95 at most 100 ms and event-loop delay p99 at most 20 ms; at 100,000 queues (`PERF_EXPLORER_LARGE=0` skips it) the same run is measured and printed, never asserted (OQ-665).
  - The figures are **synthetic**: the broker answers from memory (one turn of the event loop per request, standing in for a socket), so they are the engine's own CPU and not a lab run. The lab run is `pnpm nx run svc-explorer:it`.
  - The harness prints the idle event-loop delay it measured first. On Windows that floor is about 16 ms (the operating system's timer tick, whatever the sampling resolution), so a loop-delay figure there is conservative; on Linux the floor is about 1 ms.
  - Where it runs in CI (pull request, nightly) is not decided (OQ-544, OQ-671): no workflow runs it yet.

- `explorer-ui-20k` (`pnpm nx run perf:explorer-ui-20k`, M0-54 AC-26): the real window source of `@app/explorer-model` (the one the explorer page uses) reading through a data port that runs the real `inventory.query` action over a 20,000-queue index, while sweeps keep installing versions. 1,000 interactions (scroll jumps, text filters, facet changes, sorts; a fixed random sequence) are each timed from the call to the rows of the first block. It asserts every request has a limit of 200 or less, no window failed and the p95 per interaction is at most 300 ms, and prints the resubscribe, refresh and version-change counts of the sources; the 100,000-queue run (`PERF_EXPLORER_UI_LARGE=0` skips it) is printed, never asserted.
  - It measures **engine plus adapter in Node** and says so in its output: no transport, no rendering and no browser. Its data port has no live topic, so the resubscribe count is the source's reaction to the rows it was told were on screen. The time from input to painted rows in a browser is AC-27 (`explorer-ui-20k-browser`), which is **planned**: it needs the browser driver and issue #277, and no browser figure is claimed until it runs.

## Invariants

- Dependencies follow the type:test row of blueprint 2.2; `pnpm nx lint perf` enforces them.
- A harness prints what it measured and labels the data it measured on (synthetic or lab). A budget is asserted only where its spec says so.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p perf
pnpm nx run perf:explorer-20k
pnpm nx run perf:explorer-ui-20k
```
