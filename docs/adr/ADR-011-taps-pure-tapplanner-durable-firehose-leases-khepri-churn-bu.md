# ADR-011: Taps: pure TapPlanner, durable firehose leases, Khepri churn budgets

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

A literal-typed TapQueueSpec defines an exclusive, auto-delete, non-durable classic queue with drop-head and a max-length. Bindings are copied with their arguments, policy matches are simulated, and alarms and classic availability are checked. Diverting exchange types are refused. Tap queues carry an ownership argument, and orphans are swept. Firehose lease rows are written before enabling and reconciled at start. Tap queues are reused across binding changes. Declares are rate-limited per broker, and the team server enforces a churn budget.

## Rationale

Satisfies DC-17 to DC-20. On 4.3 every declare and delete is a Khepri metadata write.

## Alternatives considered

Exchange-to-exchange taps by default; server-named queues; unbounded re-declares.

## Consequences

Exhausted budgets return 429. The orphan sweep deletes only objects we own.

## Amendments

A-8: firehose traces get small max_payload_bytes and narrow patterns, disk headroom checks and alarm watch; traces are deleted at lease end and verified per node. Minor fixes: neutralise matching DLX policies on tap queues; PCRE-compatible pattern evaluation failing closed; configurable prefixes. See [docs/plan/amendments.md](../plan/amendments.md).
