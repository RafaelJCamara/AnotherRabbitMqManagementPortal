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
