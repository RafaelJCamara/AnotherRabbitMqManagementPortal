# S-13 management API cost at 20,000 and 100,000 queues (M0-48)

What it costs a RabbitMQ broker to be listed by the explorer's sweep, and what the engine pays to serve windows from the result. Written with slice F of M0-48 (`docs/specs/M0-48.md`); it answers OQ-662 and OQ-672 with measurements and leaves every decision to the maintainer.

**Status.** Measured on 2026-10-21 on one Windows developer machine (Docker Desktop, WSL2), **not on the Linux CI runner**. Every lab figure below was produced by `pnpm nx run svc-explorer:it` (the raw lines are printed by the run); every "synthetic" figure by `pnpm nx run perf:explorer-20k`. A Linux run of the same commands is still owed (OQ-672). No figure here is an estimate: where something was not measured, the section "Not measured" says so.

## What was measured

| Question | Where | Command |
| --- | --- | --- |
| What does the sweep, as the engine sends it, cost the broker and take end to end? | Lab brokers, through the real management adapter, the real `BrokerScheduler` background lane and a recording proxy | `pnpm nx run svc-explorer:it '--versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6'` |
| Is a window served from the index fast, and does it ask the broker for anything? | The same run: 200 windows through `inventory.query` under the executor, then a pinned scroll over every queue | the same |
| What would other ways of listing every queue cost the same broker? | The same run, plain GETs at the broker, outside the engine | the same (the `S-13` test) |
| 100,000 queues | RabbitMQ 4.2.9 and 4.3.6 only (OQ-672) | `IT_QUEUES=100000 pnpm nx run svc-explorer:it '--versions=4.2.9,4.3.6'` |
| What does the engine's own CPU do to a window and to the event loop while sweeps keep installing versions? | Synthetic broker (answers from memory), real index and sweeper | `pnpm nx run perf:explorer-20k` |

### Method

- **Seed.** `libs/testkit/src/it/seed-queues.ts` imports definitions (`POST /api/definitions`) in batches of 2,500: durable classic queues named `queue-000000` and up, spread evenly over four vhosts (`explorer-00` to `explorer-03`), with a permission for the lab login on each. Importing is one request per batch (8 requests, 7 to 10 s for 20,000 queues; 68 to 72 s for 100,000), against one request per queue for the management API, which is why it was chosen. The run then waits until `object_totals.queues` of `/api/overview` equals the seeded count. The queues are idle: no messages, no consumers, no connections.
- **Engine side.** The management adapter (`createMgmtHttpClient`) is pointed at a small forwarding proxy in front of the broker. The proxy records each request line exactly as the broker receives it and how long the broker took to answer (`brokerAnswer`). The adapter is wrapped by `scheduleMgmtRead` over a default `BrokerScheduler` (one background request at a time, 200 ms between requests when the broker is healthy). The sweeper is the real one on the real clock.
- **Alternatives.** `libs/testkit/src/it/s13-alternatives.ts` lists every queue with plain GETs (the same `columns` the adapter asks for): per vhost at `page_size` 100, 200 and 500 with the sweep's flags (`disable_stats=true`, `enable_queue_totals=true`), per vhost at 500 with statistics on (no flags), one global paged list at 500, and one unpaged global list (which the engine cannot send: the adapter always pages, DC-48). At 20,000 queues each variant ran twice, the second round in reverse order, to tell the cost of a variant from the cost of coming after the others. At 100,000 queues only three variants ran, once: the others take hours at that size.
- **Windows.** 200 `inventory.query` calls under `createTestExecutor`, rotating six filter and sort shapes and limits 1, 200 and 500, then a scroll over the whole index pinned to one version. The test asserts p95 at most 100 ms, that the broker saw no request while windows were read, and that the scroll saw every queue exactly once.

### Environment

| | |
| --- | --- |
| Host | Windows 11 Home 10.0.26300, Intel Core i9-14900HX (24 cores, 32 threads), 31.7 GiB RAM |
| Containers | Docker Desktop 29.6.1 on WSL2 (Linux 5.15.167.4), 32 CPUs visible, 15.45 GiB for the VM; one single-node, plain-HTTP broker at a time from `testing/broker-lab` (images pinned by digest in `testing/broker-lab/versions.json`) |
| Engine | Node 24.19.0 (the pin is 24.22), loopback only: the engine, the proxy and the broker share the CPU of one machine |
| Noise | Other agent sessions were running builds on the same machine during the runs. The 20,000-queue run was done twice (a first run before slice I and the cadence landed, and the final run, on the rebased tree): sweep wall times agreed within about 13 %. Treat every figure as good to about that |

## Results at 20,000 queues (lab)

Queues: 20,000 in four vhosts (five vhosts on the broker, the default one empty), idle. One sweep is the vhost list, one queue list and one exchange list per vhost, and one connection list: 48 requests, of which 41 are queue pages.

### The sweep as the engine runs it

| Version | Sweep wall (s) | Broker answer time, all requests (s) | Per queue page (ms) | Window p50 / p95 / max (ms) |
| --- | --- | --- | --- | --- |
| 3.13.7 | 17.5 | 7.6 | 184 | 0.84 / 2.51 / 10.92 |
| 4.0.9 | 17.0 | 7.2 | 175 | 0.58 / 1.61 / 6.68 |
| 4.1.8 | 17.3 | 7.5 | 182 | 0.62 / 1.90 / 7.81 |
| 4.2.9 | 16.3 | 6.3 | 154 | 0.57 / 1.67 / 7.16 |
| 4.3.6 | 15.7 | 5.9 | 143 | 0.53 / 1.18 / 6.83 |

The rest of the wall time is the scheduler's pause between background requests (47 pauses of about 200 ms). The sweeper itself measured 15.6 to 17.4 s of server time (it counts the wait for the scheduler). Every request had `page` and a `page_size` of 500 or less, every queue list carried `disable_stats=true` and `enable_queue_totals=true`, the index count equalled `object_totals.queues`, and the broker saw no request while windows were read.

### Other ways of listing the same queues

Total broker answer time in seconds, round 1 / round 2 (round 2 in reverse order), the five versions side by side.

| Variant | Requests | MiB | 3.13.7 | 4.0.9 | 4.1.8 | 4.2.9 | 4.3.6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| per vhost, `page_size` 100, stats off | 201 | 5.0 | 29.2 / 30.8 | 27.2 / 31.4 | 29.1 / 27.9 | 27.4 / 27.9 | 26.4 / 27.5 |
| per vhost, `page_size` 200, stats off | 101 | 5.0 | 14.0 / 15.6 | 14.3 / 14.7 | 14.3 / 14.1 | 13.2 / 14.7 | 13.6 / 14.5 |
| per vhost, `page_size` 500, stats off (the sweep) | 41 | 5.0 | 6.5 / 6.9 | 6.3 / 6.3 | 6.2 / 6.3 | 6.2 / 6.1 | 5.9 / 6.4 |
| per vhost, `page_size` 500, statistics on (no flags) | 41 | 6.6 | 2.5 / 3.6 | 2.5 / 2.5 | 2.7 / 2.5 | 3.2 / 3.1 | 3.0 / 3.0 |
| one global list, `page_size` 500, stats off | 40 | 5.0 | 25.5 / 31.0 | 21.7 / 22.1 | 22.0 / 21.7 | 20.2 / 21.0 | 19.5 / 20.4 |
| one global list, no `page`, stats off | 1 | 5.0 | 1.0 / 1.0 | 1.0 / 0.9 | 0.9 / 0.6 | 0.8 / 0.8 | 0.7 / 0.7 |

Slowest single request over all versions and both rounds: 200 to 583 ms (page size 100), 173 to 265 ms (200), 195 to 290 ms (500), 71 to 165 ms (statistics on), 677 to 1,175 ms (global paged), 615 to 1,038 ms (unpaged, the one request). Reversing the order moved a total by 0 to 5.5 s (the largest: the global paged list on 3.13.7, 25.5 to 31.0 s). The order from fastest to slowest (unpaged, statistics on, page 500, page 200) held in every version and both rounds; page size 100 and the global paged list trade places in some.

## Results at 100,000 queues (lab, 4.2.9 and 4.3.6)

Queues: 100,000 in four vhosts (25,000 each), idle. One sweep is 208 requests, of which 201 are queue pages.

| Version | Sweep wall (s) | Broker answer time (s) | Per queue page (ms) | Slowest queue page (ms) | Window p50 / p95 / max (ms) |
| --- | --- | --- | --- | --- | --- |
| 4.2.9 | 198.7 | 155.0 | 771 | 1,266 | 3.25 / 10.48 / 45.07 |
| 4.3.6 | 202.4 | 158.8 | 790 | 1,161 | 3.13 / 8.83 / 40.10 |

| Variant (once) | Requests | MiB | 4.2.9 (s) | 4.3.6 (s) |
| --- | --- | --- | --- | --- |
| per vhost, `page_size` 500, stats off (the sweep) | 201 | 25.0 | 151.7 | 144.4 |
| per vhost, `page_size` 500, statistics on (no flags) | 201 | 33.0 | 51.4 | 51.6 |
| one global list, no `page`, stats off | 1 | 25.0 | 6.4 | 6.0 |

The index count again equalled `object_totals.queues` (100,000), nothing was dropped, and a pinned scroll saw every queue once.

## Engine cost (synthetic broker)

The broker is the scripted one of `svc-explorer`'s fakes: it answers from memory (the harness gives the event loop one turn per request, as waiting for a socket does) and parses each page with the sweeper's schema. So these are **synthetic** figures for the engine's own CPU: building a version of the index, sorting, filtering, serving windows. A sweep loop keeps installing versions while 1,000 windows with mixed filters, sorts, offsets and limits are read. Event-loop delay is `monitorEventLoopDelay` sampled every millisecond.

| Queues | Versions installed | Sweep median (ms) | Window p50 / p95 / max (ms) | Loop delay p99 raw / above the idle floor (ms) | Idle floor p99 (ms) |
| --- | --- | --- | --- | --- | --- |
| 20,000 (run 1 of 4) | 22 | 120 | 0.73 / 9.43 / 16.92 | 13.96 / 0 | 16.07 |
| 20,000 (run 2 of 4) | 22 | 117 | 0.72 / 7.54 / 16.81 | 14.16 / 0 | 16.74 |
| 100,000 (run 1 of 4) | 5 | 3,022 | 5.05 / 61.71 / 92.49 | 69.66 / 54.41 | 16.25 |
| 100,000 (run 2 of 4) | 5 | 3,029 | 5.22 / 63.08 / 78.79 | 70.84 / 55.33 | 16.52 |
| 20,000 (run 3 of 4, after the final rebase) | 22 | 190 | 1.08 / 11.24 / 19.72 | 15.18 / 0 | 16.51 |
| 100,000 (run 3 of 4) | 5 | 2,680 | 4.61 / 56.69 / 84.84 | 70.12 / 54.88 | 16.24 |
| 20,000 (run 4 of 4) | 22 | 111 | 0.60 / 6.91 / 19.77 | 11.80 / 0 | 16.32 |
| 100,000 (run 4 of 4) | 5 | 2,293 | 3.58 / 43.87 / 81.90 | 62.42 / 47.37 | 16.05 |

- The target of one new version every 50 ms was not reachable: a sweep takes about 120 ms of engine time at 20,000 queues (22 installs in the run) and about 3 s at 100,000 (5 installs), while windows are being read. The harness starts the next sweep as soon as the last one ended when it overran.
- The **idle floor** is what the sampler reads on a loop doing nothing: about 16 ms on this Windows machine (the operating system's timer tick is 15.6 ms whatever resolution is asked for); on Linux it is expected to be about the sampling resolution of 1 ms, which was not measured. AC-24's limit of 20 ms is applied to the delay above that floor, which where the floor is 1 ms is the limit as written. On three earlier 20,000-queue runs of the same harness the raw p99 was 16.8, 21.3 and 20.0 ms (1.7, 5.9 and 4.4 above the floor) and the window p95 was 10.9, 13.0 and 12.6 ms: a raw 20 ms limit is not a stable test on this platform.
- **At 100,000 queues the budget is exceeded** (47 to 55 ms above the floor, window p95 44 to 63 ms) in the harness. In isolation, on the same data, one sweep of 100,000 queues cost about 240 ms of engine time with a loop delay of at most 6.5 ms, a sort of the window by `messages` on a fresh version cost 33 ms (by name 5 ms), and a text filter 11 ms; so the harness figure is the mix of reads and installs together, which was not taken apart further (OQ-665). That is the evidence the open question waits for: a worker or a chunked build and sort is a new issue.

### Search (synthetic broker)

`search.query` over a complete index, through the executor: 500 searches rotating a prefix, a substring, a miss and two others. AC-25 asserts its budget at 20,000 names; this run is the 100,000-name figure it left to slice F. Two runs each:

| Names in the index | Search p50 (ms) | Search p95 (ms) | Search max (ms) |
| --- | --- | --- | --- |
| 20,100 | 0.74 / 0.53 | 3.22 / 2.47 | 7.79 / 7.40 |
| 100,100 | 3.40 / 2.86 | 6.46 / 5.48 | 9.63 / 11.42 |

The target in the spec is a p95 of 50 ms. The search runs on the event loop; its worst single call here (11 ms) is below the 20 ms loop budget, but the loop delay was not sampled during it.

## What the numbers say about the defaults

These are readings of the tables above, on an idle broker spread over four vhosts. None is a decision.

| Default (M0-48 spec, `DEFAULT_EXPLORER_LIMITS`) | What was measured |
| --- | --- |
| Per vhost, paged, `page_size` 500 (the adapter's ceiling) | At 20,000 queues the total broker time falls from about 28 s (100) to 14 s (200) to 6 s (500): it follows the number of requests, about 0.15 s per request regardless of page size. A global list is 3 to 5 times worse than the same queues per vhost (20 to 31 s, slowest request up to 1.2 s). The per-page cost looks proportional to the number of queues in the scope: about 0.15 s per page with 5,000 queues in the vhost, 0.5 to 0.8 s with 20,000 (global), 0.7 to 0.8 s with 25,000 (the 100,000-queue sweep). That is consistent with the broker walking the whole list for every page; it was not looked into on the broker. If it holds, a broker with all its queues in one vhost is worse than this seed, and that was **not measured** |
| `disable_stats=true` and `enable_queue_totals=true` on queue lists | On these idle queues the same per-vhost sweep with statistics on and no flags took 2.5 to 3.6 s against 5.9 to 6.9 s with the flags (51 s against 144 to 152 s at 100,000). The answer is larger (6.6 MiB against 5.0) and still faster. Which of the two flags costs the time was not separated, and with no message traffic the statistics cost almost nothing, so this does **not** show that the flags are wrong on a busy broker; it shows they are not free |
| Unpaged | One unpaged list of every queue took 0.6 to 1.0 s at 20,000 and 6.0 to 6.4 s at 100,000 (25 MiB in one answer), against about 6 s and about 150 s paged per vhost. The engine cannot send it (DC-48), and the adapter's body limit is 16 MiB, so the 100,000-queue answer would be refused. Whether paging is worth a 25-fold cost at that size is for the adapter's owner |
| Cadence: wait `clamp(30 s, 15 min, 50 x server time)` after a sweep | At 20,000 queues the server time is about 16 s, so the wait is about 13 min and the broker answers for 6 to 8 s in about 14 min (under 1 %). At 100,000 queues the server time is about 200 s, so the wait is the 15 min cap: the broker answers for about 155 s in about 18 min, **about 14 % of its time**, on an idle broker. The formula holds the load down but not below that |
| `maxRowsPerConnection` 250,000, 128 MiB | 100,000 queues were all kept (`dropped` 0); engine memory was not measured |

## Not measured

- A busy broker (message traffic, consumers, connections): statistics cost, and the broker's CPU and memory while listing.
- All queues in one vhost, a three-node cluster, TLS, a remote broker (loopback only here), RabbitMQ 3.13.7, 4.0.9 and 4.1.8 at 100,000 queues, the effect of the `columns` parameter, each flag alone, and a page size other than 100, 200 and 500.
- The broker's CPU and memory during the sweep, and the engine's memory for a 100,000-queue index.
- A Linux run (CI): the figures above are from a Windows host with Docker Desktop.
- Per-vhost against global at 100,000 queues, page sizes 100 and 200 at 100,000 queues, and a second round at 100,000 queues (they take hours).

## Reproduce

```sh
pnpm nx test testkit --testNamePattern=AC-22                    # golden replay, no Docker
pnpm nx run svc-explorer:it '--versions=4.2.9,4.3.6'            # AC-23 and the S-13 figures; needs Docker
IT_QUEUES=100000 pnpm nx run svc-explorer:it '--versions=4.2.9,4.3.6'
pnpm nx run perf:explorer-20k                                   # AC-24; PERF_EXPLORER_LARGE=0 skips 100,000
```

The lab and perf runs print their figures with `process.stdout.write` because Vitest 5 hides the console output of a passing test; run `node libs/testkit/src/it/run-it.ts svc-explorer --versions=4.3.6` (or `npx vitest run --config apps/perf/vitest.perf.config.mts`) to see them when Nx shows only the summary.
