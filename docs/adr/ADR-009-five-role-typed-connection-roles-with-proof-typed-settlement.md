# ADR-009: Five role-typed connection roles with proof-typed settlement

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Each broker profile has these roles:
- control;
- peek: one job per connection, never publishes;
- source: replay and move consumers;
- publish: confirm channels only;
- observe: taps and streams.
Leases expose only their role's methods. ack requires a ConfirmedCopyProof or a DestructiveConsentProof. nack accepts requeue only as the literal true. Returning a source message requires a SafeReturnProof. Budgets come from the BrokerProfile and provider presets.

## Rationale

Refines DC-11 and DC-12, and makes 'peek never publishes' and 'never nack a finite-L QQ source' compile-time properties.

## Alternatives considered

One pooled connection; one connection per job; untyped channels.

## Consequences

Uses slightly more connections, which are visible in the budget view. Team mode adds per-user keys.

## Amendments

A-9: settlement proofs are nominal (unique-symbol/private-constructor brands, runtime WeakSet check, architecture + type tests). A-10: per-broker cap on the tool's own connections; lazy role connections with idle close. See [docs/plan/amendments.md](../plan/amendments.md).
