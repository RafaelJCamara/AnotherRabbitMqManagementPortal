# svc-metrics

Prometheus-first, demand-driven metrics per broker with management sampling as the fallback: the ScrapePlanner, the bounded hot store, the collector, the forecast and the `metrics.query`, `metrics.forecast` and `metrics.live` surfaces (MON-01, MON-05 core; DC-32, DC-33, ADR-024). Spec: [docs/specs/M1-26.md](../../../docs/specs/M1-26.md).

Tags: `type:service`, `runtime:node`.

## Public API

- `createMetricsModule(deps)` returns `{ id, actions, topics, topicSources, jobs, stop() }`. The composition root registers the two actions with the executor, `topicSources` with the hub's `TopicRegistry`, and calls `stop()` in the `taps-firehose` drain phase (quit, SIGTERM, emergency; not suspend).
- `MetricsModuleDeps`: `prom` (`PromReadPort`: a scrape read to samples, behind the BrokerScheduler and with errors mapped), `mgmt` (`MgmtReadPort`, scheduled), `profiles`, `connections`, and optional `clock`, `timers`, `limits` (`DEFAULT_METRICS_LIMITS`). The module never gets an adapter, a chunk, a socket or a write port.
- `metrics.query` (`POST /connections/{cid}/metrics/queries`, `broker.read`): up to 50 series (cluster metric, node metric with its node, queue metric with its queue), a time range, `maxPoints` (at most 2,000, last-in-bucket thinning, the newest point always kept) and `rate` (counters as per-second rates across resets). A series the engine does not hold is `found: false` with no points, never a zero. The answer carries the status: `state` (`live`, `stale`, `loading`, `unavailable`), `source` (`prometheus`, `management`, `none`), `partial` reasons, `fallbackReason`, `approximate` and what was dropped.
- `metrics.forecast` (`POST /connections/{cid}/metrics/forecasts`): the drain ETA of a queue's depth or of the cluster's, from `@app/forecast`: `ok` with a 95 % band, `reached`, `moving-away`, `no-reliable-forecast` (R2 below 0.95) or `insufficient-data`.
- `metrics.live` (`latest`, `snapshot-delta`): the newest point of every cluster and node series plus the queues the subscription names (at most 50) and a `~status` item; it follows the collector's rounds and publishes a series only when its point is newer.
- `planScrape(input)`: the pure ScrapePlanner, exported for the lab run and the perf harness.

## How it works

- **Demand.** A call to `metrics.query`, `metrics.forecast` or a `metrics.live` subscription is demand (and names the queues wanted). The collector starts a loop per connection; no demand for 10 minutes ends it with no timer left. Nothing is requested for a connection nobody asked about.
- **Plan** (`internal/scrape-planner.ts`, pure, reads the BrokerProfile only): one target per listener the profile lists, scraped directly; the aggregated `/metrics` always; `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&vhost=` only for demanded queues and only where `perObjectAllowed` (Amazon MQ: never), with `queue=<regex>` only where the registry allows it, in chunks of at most 2,000 characters and at most 8 requests; the interval is the largest of the provider minimum (60 s on Amazon MQ), 15 s and ten scrape durations, at most 5 minutes. A profile whose nodes outnumber its listeners is marked `partial` (`load-balancer-fronted` or `nodes-without-endpoint`).
- **Round** (`internal/collector.ts`, `ingest.ts`): the targets are read one after another in the background lane through the scheduled port; the nodes are merged (a cluster series from the lowest node name, a node series per node, a queue series from the leader); one timestamp per round. A node that does not answer makes the round `partial` (`targets-unreachable`); a round where every node failed counts toward the fallback.
- **Fallback** (`internal/mgmt-sampler.ts`): no endpoint, or three failed rounds, reads `/api/overview` and `/api/nodes` (and single queues only where per-object reads are allowed) for 5 minutes, then tries Prometheus once. Counters from sampling are labelled approximate; with statistics off the series the overview cannot give are absent.
- **Store** (`internal/store-hot.ts`): a ring of 720 points per series (about an hour), 2,000 queue series per broker (the pinned queues and the highest backlogs stay), 64 brokers; every drop is counted and returned in the status (I-13).

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2). The scrape is read to samples by `createPromReader` in `adapter-prometheus`, which the composition root builds.
- All broker I/O is through the scheduled ports in the `background` lane (I-8); no socket here (I-9). No broker version or provider is compared (I-3): the profile and the registry say what is allowed.
- Every buffer is bounded by items and bytes with counted drops (I-6); the parser gives the loop a turn every 256 KiB and 5,000 lines (I-5).
- No secret reaches an output (I-10): errors are fixed texts and Problems carry a code only.
- No mutation: both actions are queries, no `WritePort` is reachable (I-2).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-metrics adapter-prometheus forecast
pnpm nx test testkit --testNamePattern=golden                  # the recorded Prometheus pages through the real client, parser, collector and router
pnpm nx test engine --testNamePattern=AC-18                    # the composed engine: served, drained, scraping a loopback listener
pnpm nx run perf:metrics-100k                                  # 400,000 series and 100,000 queues of demand (count-based)
```
