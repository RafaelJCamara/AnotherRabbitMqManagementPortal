# ADR-006: Single fail-closed ActionExecutor for UI, CLI, MCP and jobs

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Every mutation and message touch goes through one executor. Unknown actions are denied. An unset environment class means prod. A failed audit-attempt write denies the action. Plans are bound to the principal, the inputHash and the BrokerProfile fingerprint. Execute requires an idempotency key and runs a TOCTOU revalidation. Plan TTL is 5 min, or 24 h while awaiting approval. Approvers must differ from the requester. A direct call that needs a plan returns 428 with an auto-created plan. WritePorts are injectable only into action and job implementations.

## Rationale

DC-40 and DC-42. MCP and jobs run in process, so policy cannot be HTTP-bound. Fail-closed defaults keep agent-written actions safe.

## Alternatives considered

Per-surface guards; per-feature confirmations; HTTP-only middleware.

## Consequences

Two-phase actions implement plan and revalidate, and tests prove plan purity. Plan payloads are encrypted and purged after use.

## Amendments

A-11: allow-all applies only to the UI principal in single-user modes; CLI and MCP principals are limited to their token scope and DC-42 (a read-only token calling purge gets FORBIDDEN). See [docs/plan/amendments.md](../plan/amendments.md).
