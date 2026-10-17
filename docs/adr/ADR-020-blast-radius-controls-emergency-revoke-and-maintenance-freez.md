# ADR-020: Blast-radius controls: emergency revoke and maintenance freeze

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

An admin action revokes every one of the tool's leases on a broker across all users. It stops taps, switches firehose off, flushes peeks and parks or drains replays. A per-broker freeze forces read-only mode and pauses pollers.

## Rationale

A team server holding delegated sessions against production brokers needs an incident switch.

## Alternatives considered

Manual per-user cleanup.

## Consequences

Both are audited, drilled in E2E, and exposed as read-only status over MCP.
