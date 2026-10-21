# ADR-024: Prometheus-first, demand-driven metrics behind one BrokerScheduler

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

A pure ScrapePlanner scrapes each node directly:
- queue= filters only on 4.3+;
- on Amazon MQ, a 60 s minimum interval and never per-object;
- the interval is at least 10x the scrape duration.
The BrokerScheduler runs lanes with at most one background management request per broker, plus AIMD backoff. Storage keeps raw points plus 5m and 1h rollups under cardinality caps, and forecasts are pure functions.

## Rationale

Required by DC-32 and DC-33. The tool's own load on the broker is the scaling risk that matters.

## Alternatives considered

Management message_stats only; a mandatory external Prometheus; chunked tiers from day one.

## Consequences

Unwatched queues get net-trend forecasts only, labelled as such.

## Addendum (2026-10-21, M0-48 slice F): S-13, the management API cost of the explorer's sweep

Nothing in the decision above changes. The explorer (`svc-explorer`) lists the broker through the BrokerScheduler's background lane, and S-13 measured what that costs. The method, the environment and every table are in [S-13: management API cost at 20,000 and 100,000 queues](../architecture/s-13-mgmt-api-cost-100k.md); this addendum records the defaults the sweep runs with and what the numbers say about them. The figures come from one Windows developer machine (Docker Desktop), idle queues spread over four vhosts; a Linux run is still owed (OQ-672).

**Defaults in force** (`DEFAULT_EXPLORER_LIMITS`, `libs/engine/svc-explorer/src/deps.ts`): one list per vhost and kind, `page_size` 500 (the adapter's ceiling), `disable_stats=true` on every list and `enable_queue_totals=true` on queue lists (the adapter drops either for a product or version that rejects it), one background request at a time, a wait of `clamp(30 s, 15 min, 50 x the server time of the last sweep)` between sweeps, no sweep after 10 minutes without demand, and at most 250,000 rows and 128 MiB per connection.

**Measured**

| | 20,000 queues | 100,000 queues |
| --- | --- | --- |
| Requests per sweep | 48 (41 queue pages) | 208 (201 queue pages) |
| Sweep wall time, RabbitMQ 3.13.7 to 4.3.6 | 15.7 to 17.5 s | 198.7 s (4.2.9), 202.4 s (4.3.6) |
| Broker answer time within it | 5.9 to 7.6 s | 155.0 s (4.2.9), 158.8 s (4.3.6) |
| Window from the index, p95 | 1.2 to 2.5 ms | 8.8 to 10.5 ms |
| Wait before the next sweep, from the formula | about 13 min | the 15 min cap |
| Share of broker time spent answering sweeps, from the two rows above | under 1 % | about 14 % |

**Readings.** `page_size` 500 and one list per vhost are the cheapest of the paged shapes measured with the sweep's flags (page sizes 100 and 200 cost two to five times as much; one global paged list cost three to five times as much). The per-page cost grows with the number of queues in the scope, so a broker with all its queues in one vhost is expected to be worse than the seed used here, and was not measured. On idle queues a per-vhost sweep with statistics on and no flags took about half the broker time of the sweep with `disable_stats` and `enable_queue_totals`; that does not show the flags are wrong for a busy broker, and the two flags were not separated. An unpaged list of every queue cost about an eighth of the paged sweep at 20,000 queues and about a twenty-fourth at 100,000, but the engine cannot send it (DC-48) and its answer at 100,000 queues (25 MiB) is over the adapter's 16 MiB body limit. The decisions these readings bear on (the flags, the cadence cap, paging against unpaged) are open (OQ-662, OQ-663, OQ-665); nothing was changed here.