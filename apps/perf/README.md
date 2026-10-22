# perf

Performance harnesses of the engine and its services (run by Node; `explorer-ui-20k-browser` also drives a real Chromium): budgets measured on synthetic data and printed for the S-13 and S-14 records.

Tags: `type:test`, `runtime:node`.

## Public API

- None: `src/index.ts` exports nothing. A harness is a file `src/<name>/<name>.perf.ts` with its own Nx target; it is run by `vitest.perf.config.mts` and never by `nx test` (a loaded machine would make a timing assertion flaky in the unit run).

## Harnesses

- `explorer-20k` (`pnpm nx run perf:explorer-20k`, M0-48 AC-24): the `inventory.query` action of `svc-explorer` over the real index and sweeper, fed by the scripted broker of `svc-explorer`'s fakes. A sweep loop keeps installing new index versions while 1,000 window queries (mixed filters, sorts, offsets and limits, a fixed random sequence) run, with `monitorEventLoopDelay` sampling every millisecond. At 20,000 queues it asserts engine time per window p95 at most 100 ms and event-loop delay p99 at most 20 ms; at 100,000 queues (`PERF_EXPLORER_LARGE=0` skips it) the same run is measured and printed, never asserted (OQ-665).
  - The figures are **synthetic**: the broker answers from memory (one turn of the event loop per request, standing in for a socket), so they are the engine's own CPU and not a lab run. The lab run is `pnpm nx run svc-explorer:it`.
  - The harness prints the idle event-loop delay it measured first. On Windows that floor is about 16 ms (the operating system's timer tick, whatever the sampling resolution), so a loop-delay figure there is conservative; on Linux the floor is about 1 ms.
  - Where it runs in CI (pull request, nightly) is not decided (OQ-544, OQ-671): no workflow runs it yet.

- `explorer-ui-20k` (`pnpm nx run perf:explorer-ui-20k`, M0-54 AC-26): the real window source of `@app/explorer-model` (the one the explorer page uses) reading through a data port that runs the real `inventory.query` action over a 20,000-queue index, while sweeps keep installing versions. 1,000 interactions (scroll jumps, text filters, facet changes, sorts; a fixed random sequence) are each timed from the call to the rows of the first block. It asserts every request has a limit of 200 or less, no window failed and the p95 per interaction is at most 300 ms, and prints the resubscribe, refresh and version-change counts of the sources; the 100,000-queue run (`PERF_EXPLORER_UI_LARGE=0` skips it) is printed, never asserted.
  - It measures **engine plus adapter in Node** and says so in its output: no transport, no rendering and no browser. Its data port has no live topic, so the resubscribe count is the source's reaction to the rows it was told were on screen. The time from input to painted rows in a browser is AC-27 (`explorer-ui-20k-browser`, below).

- `explorer-ui-20k-browser` (`pnpm nx run perf:explorer-ui-20k-browser`, M0-54 AC-27, #280): the explorer's queue page **in a real Chromium** at 1280x720. It builds `web` and `engine`, starts the engine bundle in local mode (it serves the production web build under the real Content-Security-Policy, the way `web-csp-check` does), opens `/c/perf/explorer/queues` and drives a fixed sequence of scroll jumps (the scrollbar's jump, by `scrollTop`), text filters, facet changes (queue types, vhosts) and sorts (real mouse clicks on the header) with a CDP driver written for it (`cdp.ts`, no new dependency). 500 interactions are timed after 12 warm-up ones (`PERF_EXPLORER_UI_BROWSER_INTERACTIONS` changes the count). Each is timed from the input (`event.timeStamp` of the click or Enter, `performance.now()` before a scroll jump) to the end of the first frame whose DOM holds the new rows, **checked by content** against an oracle (the names of the eight rows at the top of the viewport, the matched count, the sort mark and the scroll position), so a screen that merely changed does not count. The filter's 200 ms pause is excluded by construction (the text is entered and Enter pressed in one task, which applies the filter at once and cancels the pause). It asserts: p95 under 300 ms, every request has a limit of 200 or less, no long task above 50 ms (`PerformanceObserver` `longtask`, from the first timed interaction to the last), and zero CSP or Trusted Types reports (`securitypolicyviolation` events, `Audits` issues, console and exception text) over the whole life of the page, boot included.
  - **What stands in for the engine.** The engine bundle registers no explorer module yet (OQ-441), so `inventory.query` is answered by the harness from a 20,000-queue `createFakeExplorerData` through the DevTools `Fetch` domain: the page's `EngineApi`, `HttpClient`, window source, AG Grid, filter bar and router are the real ones; the engine's `svc-explorer` is not on the path (`explorer-ui-20k` has it, in Node). The live socket of the page is replaced in the page by a stand-in that speaks the live protocol minimally (hello, sub, a snapshot that holds only the version marker, ping), because the engine would end the `explorer.window` subscription with "no such connection" and put the page in its "live updates ended" state; the topic's own cost is not measured here.
  - **What the figure is.** One machine, headless Chromium (`--headless=new`, software compositing), the answer from memory over the DevTools protocol (the figure prints the data port's own time and the interception round trip so they can be subtracted). "Painted" is the end of the main-thread work of the frame that holds the rows (a message posted from that frame's animation-frame callback), not light on a screen, and a figure is a multiple of the 16.7 ms frame. The output names the machine, the browser and the budgets; it is not a promise for any other hardware.
  - **Flake policy.** The two timing budgets (p95, long tasks) depend on the machine's load: a failing attempt is repeated, up to `PERF_EXPLORER_UI_BROWSER_ATTEMPTS` (3) attempts in all, and the run passes when one attempt meets them; every attempt is printed. A CSP or Trusted Types report, a request over a block, rows that never appear or fewer timed interactions than planned fail at once and are never retried. Before anything is timed the page proves that its two detectors are alive (a 90 ms busy loop must be reported as a long task, an inline script as a CSP report); `PERF_EXPLORER_UI_BROWSER_ANSWER_DELAY_MS=400` slows the data port and makes the run fail on the p95, which is how the gate was shown to bite.
  - **No browser, no proof.** The browser is taken from `CSP_CHECK_BROWSER`, `PERF_BROWSER`, `CSP_SPIKE_BROWSER`, then Chrome or Edge in their default locations (Windows, macOS) or on `PATH` (Linux). Without one the test is **skipped, loudly** (a message on stderr and a skipped test, never a pass), and nothing is proved; `PERF_REQUIRE_BROWSER` makes that a failure (CI sets it). The unit specs of the judgement, the plan, the browser search and the page script run in `pnpm nx test perf` and need no browser.
## Invariants

- Dependencies follow the type:test row of blueprint 2.2; `pnpm nx lint perf` enforces them.
- A harness prints what it measured and labels the data it measured on (synthetic or lab). A budget is asserted only where its spec says so.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p perf
pnpm nx run perf:explorer-20k
pnpm nx run perf:explorer-ui-20k
pnpm nx run perf:explorer-ui-20k-browser   # needs Chrome or Edge; skips loudly without one
```


