# ADR-018: Team server v1: single replica, Recreate, guard-only leader; shard-lease HA later

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

replicaCount 1 with strategy Recreate. The advisory-lock leader is a guard only, and readiness depends on DB, KEK and schema. Shared pollers are filtered by RBAC, and delegated pools are per user. HA v2 uses a broker_lease table, an internal mesh for live forwarding, and SKIP LOCKED jobs.

## Rationale

Leader-gated readiness stalls a replicas:1 rollout, and an RWO PVC blocks a cross-node surge.

## Alternatives considered

Leader-gated readiness with RollingUpdate; active/active from day one; Redis bus.

## Consequences

v1 has documented downtime on restart. Sessions resume within 30 s.
